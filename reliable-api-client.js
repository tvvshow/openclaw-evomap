/**
 * Node.js Reliable API Client - 黄金标准 v3.0.0
 * 
 * 整合: 多Endpoint + 多Key轮询 + 限流 + 连接池 + 指数退避重试 + 熔断器 + 代理友好
 * 
 * @author node_e540d71c4944e33a
 * @version 3.0.0
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ==================== 0. Endpoint 管理器 ====================
class EndpointManager {
  constructor(options = {}) {
    this.endpoints = [];
    this.strategy = options.strategy || 'priority'; // priority | round-robin | least-used
    this.healthCheck = options.healthCheck !== false;
    this.failover = options.failover !== false;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.errorCooldown = options.errorCooldown || 60000; // 1分钟冷却
    
    this.stats = {};
    this.currentIndex = 0;
    
    if (this.healthCheck) {
      this.startHealthCheck();
    }
  }
  
  /**
   * 添加 Endpoint
   */
  addEndpoint(endpoint, priority = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
    if (!this.endpoints.find(e => e.url === url)) {
      this.endpoints.push({ url, priority, weight: 1 });
      this.stats[url] = {
        requests: 0,
        errors: 0,
        lastUsed: null,
        healthy: true,
        cooldownUntil: null,
        latency: null
      };
    }
  }
  
  /**
   * 批量添加 Endpoints
   */
  addEndpoints(endpoints) {
    if (Array.isArray(endpoints)) {
      endpoints.forEach(ep => {
        if (typeof ep === 'string') {
          this.addEndpoint(ep);
        } else if (ep.url) {
          this.addEndpoint(ep.url, ep.priority);
        }
      });
    }
  }
  
  /**
   * 获取下一个可用的 Endpoint
   */
  getNextEndpoint() {
    const healthyEndpoints = this.endpoints.filter(ep => this.isEndpointHealthy(ep.url));
    
    if (healthyEndpoints.length === 0) {
      if (this.endpoints.length > 0) {
        console.warn('[EndpointManager] No healthy endpoints, returning highest priority');
        return this.endpoints.sort((a, b) => b.priority - a.priority)[0].url;
      }
      return null;
    }
    
    let selected;
    
    if (this.strategy === 'priority') {
      // 优先选择优先级高的
      selected = healthyEndpoints.sort((a, b) => b.priority - a.priority)[0];
    } else if (this.strategy === 'least-used') {
      selected = healthyEndpoints.reduce((min, ep) =>
        this.stats[ep.url].requests < this.stats[min.url].requests ? ep : min
      );
    } else {
      // round-robin
      let attempts = 0;
      while (attempts < healthyEndpoints.length) {
        const ep = healthyEndpoints[this.currentIndex % healthyEndpoints.length];
        this.currentIndex++;
        if (this.isEndpointHealthy(ep.url)) {
          selected = ep;
          break;
        }
        attempts++;
      }
    }
    
    if (selected) {
      this.stats[selected.url].requests++;
      this.stats[selected.url].lastUsed = Date.now();
    }
    
    return selected?.url || null;
  }
  
  /**
   * 检查 Endpoint 是否健康
   */
  isEndpointHealthy(url) {
    const stat = this.stats[url];
    if (!stat) return false;
    if (!stat.healthy) {
      if (stat.cooldownUntil && Date.now() > stat.cooldownUntil) {
        stat.healthy = true;
        stat.cooldownUntil = null;
        console.log(`[EndpointManager] Endpoint recovered: ${this.maskUrl(url)}`);
        return true;
      }
      return false;
    }
    return true;
  }
  
  /**
   * 标记错误
   */
  markError(url, errorType) {
    if (!this.stats[url]) return;
    
    this.stats[url].errors++;
    this.stats[url].lastUsed = Date.now();
    
    const et = String(errorType).toLowerCase();
    
    if (et.includes('429') || et.includes('rate limit')) {
      // 限流
      if (this.failover) {
        this.stats[url].healthy = false;
        this.stats[url].cooldownUntil = Date.now() + this.errorCooldown;
        console.warn(`[EndpointManager] Endpoint rate limited: ${this.maskUrl(url)}, cooldown ${this.errorCooldown}ms`);
      }
    } else if (et.includes('403') || et.includes('forbidden')) {
      // 权限错误
      this.stats[url].healthy = false;
      console.error(`[EndpointManager] Endpoint forbidden: ${this.maskUrl(url)}`);
    } else if (et.includes('5')) {
      // 5xx 错误
      this.stats[url].healthy = false;
      this.stats[url].cooldownUntil = Date.now() + this.errorCooldown;
      console.warn(`[EndpointManager] Endpoint 5xx error: ${this.maskUrl(url)}, cooldown ${this.errorCooldown}ms`);
    }
  }
  
  /**
   * 更新延迟
   */
  updateLatency(url, latencyMs) {
    if (this.stats[url]) {
      this.stats[url].latency = latencyMs;
    }
  }
  
  /**
   * 脱敏 URL
   */
  maskUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}:***${u.port ? ':' + u.port : ''}`;
    } catch {
      return '****';
    }
  }
  
  /**
   * 获取统计
   */
  getStats() {
    return {
      totalEndpoints: this.endpoints.length,
      healthyEndpoints: this.endpoints.filter(ep => this.isEndpointHealthy(ep.url)).length,
      details: this.stats
    };
  }
  
  /**
   * 启动健康检查
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.endpoints.forEach(ep => {
        this.isEndpointHealthy(ep.url);
      });
    }, this.healthCheckInterval);
  }
  
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }
}

// ==================== 0.1 API Key 管理器 ====================
class APIKeyManager {
  constructor(options = {}) {
    this.keys = [];
    this.strategy = options.strategy || 'round-robin';
    this.healthCheck = options.healthCheck !== false;
    this.failover = options.failover !== false;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.errorCooldown = options.errorCooldown || 30000;
    
    this.stats = {};
    this.currentIndex = 0;
    
    if (this.healthCheck) {
      this.startHealthCheck();
    }
  }
  
  addKey(apiKey) {
    if (!this.keys.includes(apiKey)) {
      this.keys.push(apiKey);
      this.stats[apiKey] = {
        requests: 0,
        errors: 0,
        lastUsed: null,
        healthy: true,
        cooldownUntil: null
      };
    }
  }
  
  removeKey(apiKey) {
    const index = this.keys.indexOf(apiKey);
    if (index > -1) {
      this.keys.splice(index, 1);
      delete this.stats[apiKey];
    }
  }
  
  getNextKey() {
    const healthyKeys = this.keys.filter(key => this.isKeyHealthy(key));
    
    if (healthyKeys.length === 0) {
      if (this.keys.length > 0) {
        console.warn('[APIKeyManager] No healthy keys, returning least recently used');
        return this.keys[0];
      }
      return null;
    }
    
    let selectedKey;
    
    if (this.strategy === 'least-used') {
      selectedKey = healthyKeys.reduce((min, key) => 
        this.stats[key].requests < this.stats[min].requests ? key : min
      );
    } else {
      let attempts = 0;
      while (attempts < healthyKeys.length) {
        const key = healthyKeys[this.currentIndex % healthyKeys.length];
        this.currentIndex++;
        if (this.isKeyHealthy(key)) {
          selectedKey = key;
          break;
        }
        attempts++;
      }
    }
    
    if (selectedKey) {
      this.stats[selectedKey].requests++;
      this.stats[selectedKey].lastUsed = Date.now();
    }
    
    return selectedKey;
  }
  
  isKeyHealthy(key) {
    const stat = this.stats[key];
    if (!stat) return false;
    if (!stat.healthy) {
      if (stat.cooldownUntil && Date.now() > stat.cooldownUntil) {
        stat.healthy = true;
        stat.cooldownUntil = null;
        console.log(`[APIKeyManager] Key recovered: ****${String(key).slice(-4)}`);
        return true;
      }
      return false;
    }
    return true;
  }
  
  markError(apiKey, errorType) {
    if (!this.stats[apiKey]) return;
    
    this.stats[apiKey].errors++;
    this.stats[apiKey].lastUsed = Date.now();
    
    const et = String(errorType || '').toLowerCase();
    
    if (et === '429' || et.includes('429') || et.includes('rate limit')) {
      if (this.failover) {
        this.stats[apiKey].healthy = false;
        this.stats[apiKey].cooldownUntil = Date.now() + this.errorCooldown;
        console.warn(`[APIKeyManager] Key rate limited: ****${String(apiKey).slice(-4)}, cooldown ${this.errorCooldown}ms`);
      }
    } else if (et === '401' || et.includes('401') || et.includes('unauthorized') || et.includes('invalid')) {
      this.stats[apiKey].healthy = false;
      this.stats[apiKey].cooldownUntil = null;
      console.error(`[APIKeyManager] Key auth failed (permanent): ****${String(apiKey).slice(-4)}`);
    } else if (et === '403' || et.includes('403') || et.includes('forbidden')) {
      this.stats[apiKey].healthy = false;
      this.stats[apiKey].cooldownUntil = null;
      console.error(`[APIKeyManager] Key forbidden (permanent): ****${String(apiKey).slice(-4)}`);
    }
  }
  
  getStats() {
    const healthyKeys = this.keys.filter(key => this.isKeyHealthy(key));
    return {
      totalKeys: this.keys.length,
      healthyKeys: healthyKeys.length,
      keyDetails: this.stats
    };
  }
  
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.keys.forEach(key => this.isKeyHealthy(key));
    }, this.healthCheckInterval);
  }
  
  stopHealthCheck() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
  }
}

// ==================== 1. 滑动窗口限流器 ====================
class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.maxQPS = options.maxQPS || 10;
    this.windowMs = options.windowMs || 1000;
    this.requests = [];
  }
  
  async acquire() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < this.windowMs);
    
    if (this.requests.length >= this.maxQPS) {
      const oldest = this.requests[0];
      const waitTime = this.windowMs - (now - oldest);
      if (waitTime > 0) await this.sleep(waitTime);
      return this.acquire();
    }
    
    this.requests.push(now);
    return true;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== 2. 连接池 ====================
class ConnectionPool {
  constructor(options = {}) {
    this.maxSize = options.poolSize || 20;
    this.pool = [];
    this.waiting = [];
  }
  
  async acquire() {
    if (this.pool.length > 0) {
      return this.pool.pop();
    }
    if (this.pool.length < this.maxSize) {
      return { id: Date.now(), created: Date.now() };
    }
    return new Promise(resolve => this.waiting.push(resolve));
  }
  
  release(conn) {
    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift();
      resolve(conn);
    } else if (this.pool.length < this.maxSize) {
      this.pool.push(conn);
    }
  }
}

// ==================== 3. 熔断器 ====================
class CircuitBreaker extends EventEmitter {
  static STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };
  
  constructor(options = {}) {
    super();
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000;
    this.state = CircuitBreaker.STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }
  
  async execute(fn) {
    if (this.state === CircuitBreaker.STATES.OPEN) {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = CircuitBreaker.STATES.HALF_OPEN;
        this.emit('half_open');
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    if (this.state === CircuitBreaker.STATES.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = CircuitBreaker.STATES.CLOSED;
        this.successes = 0;
        this.emit('close');
      }
    }
  }
  
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitBreaker.STATES.HALF_OPEN) {
      this.state = CircuitBreaker.STATES.OPEN;
      this.emit('open');
    } else if (this.failures >= this.failureThreshold) {
      this.state = CircuitBreaker.STATES.OPEN;
      this.emit('open');
    }
  }
  
  getState() {
    return this.state;
  }
  
  reset() {
    this.state = CircuitBreaker.STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
  }
}

// ==================== 4. 指数退避重试 ====================
class ExponentialBackoff {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.jitter = options.jitter !== false;
  }
  
  async retry(fn) {
    let lastError;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        
        if (!this.shouldRetry(error)) {
          throw error;
        }
        
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }
  
  shouldRetry(error) {
    const retryableCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
    const retryableStatus = [408, 429, 500, 502, 503, 504];
    
    if (error.code && retryableCodes.includes(error.code)) return true;
    if (error.status && retryableStatus.includes(error.status)) return true;
    if (error.response && retryableStatus.includes(error.response.status)) return true;
    
    return false;
  }
  
  calculateDelay(attempt) {
    const exponentialDelay = this.baseDelay * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.maxDelay);
    
    if (this.jitter) {
      return cappedDelay + Math.random() * 1000;
    }
    return cappedDelay;
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== 5. 主客户端 ====================
class ReliableAPIClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL || '';
    this.timeout = options.timeout || 30000;
    
    // Endpoint 管理器（多上游支持）
    this.endpointManager = new EndpointManager({
      strategy: options.endpointStrategy || 'priority',
      healthCheck: options.healthCheck !== false,
      failover: options.failover !== false,
      errorCooldown: options.endpointCooldown || 60000
    });
    
    // 添加 Endpoints
    if (options.endpoints && Array.isArray(options.endpoints)) {
      this.endpointManager.addEndpoints(options.endpoints);
    } else if (options.baseURL) {
      this.endpointManager.addEndpoint(options.baseURL);
    }
    
    // API Key 管理器
    this.keyManager = new APIKeyManager({
      strategy: options.keyStrategy || 'round-robin',
      healthCheck: options.healthCheck !== false,
      failover: options.failover !== false,
      errorCooldown: options.errorCooldown || 30000
    });
    
    if (options.apiKeys && Array.isArray(options.apiKeys)) {
      options.apiKeys.forEach(key => this.keyManager.addKey(key));
    }
    
    // 限流
    this.rateLimiter = new SlidingWindowRateLimiter({
      maxQPS: options.maxQPS || 10,
      windowMs: options.windowMs || 1000
    });
    
    // 连接池
    this.pool = new ConnectionPool({
      poolSize: options.poolSize || 20
    });
    
    // 熔断器（每个 endpoint 独立）
    this.circuitBreakers = {};
    
    // 重试
    this.backoff = new ExponentialBackoff({
      maxRetries: options.maxRetries || 3,
      baseDelay: options.retryDelay || 1000
    });
    
    this.proxyConfig = {
      respectProxyRateLimit: options.respectProxyRateLimit !== false,
      respectRetryAfter: options.respectRetryAfter !== false
    };
    
    this.headers = { ...options.headers };
    this.authHeader = options.authHeader || 'Authorization';
    this.authPrefix = options.authPrefix || 'Bearer';
  }
  
  /**
   * 添加 Endpoint
   */
  addEndpoint(endpoint, priority) {
    this.endpointManager.addEndpoint(endpoint, priority);
    // 为新 endpoint 创建熔断器
    const url = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
    if (!this.circuitBreakers[url]) {
      this.circuitBreakers[url] = new CircuitBreaker();
    }
  }
  
  /**
   * 添加 API Key
   */
  addAPIKey(apiKey) {
    this.keyManager.addKey(apiKey);
  }
  
  /**
   * 获取 Endpoint 统计
   */
  getEndpointStats() {
    return this.endpointManager.getStats();
  }
  
  /**
   * 获取 Key 统计
   */
  getKeyStats() {
    return this.keyManager.getStats();
  }
  
  /**
   * 获取熔断器状态
   */
  getCircuitBreakerStatus(url) {
    const cb = this.circuitBreakers[url];
    return cb ? cb.getState() : 'unknown';
  }
  
  async request(path, options = {}) {
    // 1. 限流
    await this.rateLimiter.acquire();
    
    // 2. 获取连接
    const conn = await this.pool.acquire();
    
    let lastError;
    
    try {
      // 3. Endpoint + Key 选择 + 熔断 + 重试
      const result = await this.executeWithFailover(path, options, conn);
      return result;
    } catch (error) {
      lastError = error;
      throw error;
    } finally {
      this.pool.release(conn);
    }
  }
  
  /**
   * 执行请求（带故障转移）
   */
  async executeWithFailover(path, options, conn) {
    const endpoints = this.endpointManager.endpoints;
    const maxAttempts = endpoints.length * (this.backoff.maxRetries + 1);
    
    let attempt = 0;
    let lastError;
    
    while (attempt < maxAttempts) {
      // 选择 Endpoint
      const endpoint = this.endpointManager.getNextEndpoint();
      if (!endpoint) {
        throw new Error('No available endpoints');
      }
      
      // 获取/创建熔断器
      if (!this.circuitBreakers[endpoint]) {
        this.circuitBreakers[endpoint] = new CircuitBreaker();
      }
      const cb = this.circuitBreakers[endpoint];
      
      // 选择 Key
      const apiKey = this.keyManager.getNextKey();
      if (!apiKey) {
        throw new Error('No available API keys');
      }
      
      const url = path.startsWith('http') ? path : endpoint + path;
      
      attempt++;
      
      try {
        const result = await cb.execute(async () => {
          return await this.backoff.retry(async () => {
            try {
              return await this.doRequest(url, { ...options, conn, apiKey });
            } catch (err) {
              // 标记错误
              const errorType = this.extractErrorType(err);
              this.keyManager.markError(apiKey, errorType);
              this.endpointManager.markError(endpoint, errorType);
              throw err;
            }
          });
        });
        
        // 更新延迟
        const latency = result.headers['x-response-time'] || result.headers['x-latency'];
        if (latency) {
          this.endpointManager.updateLatency(endpoint, parseInt(latency));
        }
        
        return result;
      } catch (error) {
        lastError = error;
        
        // 如果是熔断器打开，继续尝试下一个 endpoint
        if (error.message === 'Circuit breaker is OPEN') {
          continue;
        }
        
        // 如果所有 endpoint 都失败了
        if (attempt >= maxAttempts) {
          throw error;
        }
        
        // 等待后重试
        await this.backoff.sleep(1000);
      }
    }
    
    throw lastError;
  }
  
  /**
   * 提取错误类型
   */
  extractErrorType(error) {
    const status = error?.status || error?.response?.status;
    if (status === 429) return '429';
    if (status === 401) return '401';
    if (status === 403) return '403';
    
    const msg = (error && error.message) ? error.message : String(error || '');
    const m = msg.toLowerCase();
    if (m.includes('429') || m.includes('rate limit')) return '429';
    if (m.includes('401') || m.includes('unauthorized')) return '401';
    if (m.includes('403') || m.includes('forbidden')) return '403';
    return 'unknown';
  }
  
  /**
   * 脱敏 Key
   */
  maskKey(key) {
    if (!key) return '(null)';
    const s = String(key);
    if (s.length <= 8) return '****';
    return `****${s.slice(-4)}`;
  }
  
  async doRequest(url, options) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      
      const requestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'ReliableAPIClient/3.0',
          ...this.headers,
          ...options.headers
        },
        timeout: this.timeout
      };
      
      if (options.apiKey) {
        requestOptions.headers[this.authHeader] = `${this.authPrefix} ${options.apiKey}`;
      }
      
      const startTime = Date.now();
      
      const req = client.request(requestOptions, (res) => {
        const latency = Date.now() - startTime;
        
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 429) {
            const retryAfter = res.headers['retry-after'];
            const e = new Error(`429 Rate limited${retryAfter ? ', retry after ' + retryAfter : ''}`);
            e.status = 429;
            reject(e);
            return;
          }
          if (res.statusCode === 401) {
            const e = new Error('401 Unauthorized');
            e.status = 401;
            reject(e);
            return;
          }
          if (res.statusCode === 403) {
            const e = new Error('403 Forbidden');
            e.status = 403;
            reject(e);
            return;
          }
          
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data: data,
            latency: latency
          });
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('ETIMEDOUT'));
      });
      
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    });
  }
  
  // 便捷方法
  get(path, options) {
    return this.request(path, { ...options, method: 'GET' });
  }
  
  post(path, data, options) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return this.request(path, { 
      ...options, 
      method: 'POST', 
      body, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  put(path, data, options) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return this.request(path, { 
      ...options, 
      method: 'PUT', 
      body, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
  
  delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}

// 导出
module.exports = ReliableAPIClient;
module.exports.EndpointManager = EndpointManager;
module.exports.APIKeyManager = APIKeyManager;
module.exports.SlidingWindowRateLimiter = SlidingWindowRateLimiter;
module.exports.ConnectionPool = ConnectionPool;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.ExponentialBackoff = ExponentialBackoff;
