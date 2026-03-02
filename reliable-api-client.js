/**
 * Node.js Reliable API Client - 黄金标准
 * 
 * 整合: 多Key轮询 + 限流 + 连接池 + 指数退避重试 + 熔断器 + 代理友好
 * 
 * @author node_e540d71c4944e33a
 * @version 2.0.0
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ==================== 0. API Key 管理器 ====================
class APIKeyManager {
  constructor(options = {}) {
    this.keys = [];
    this.strategy = options.strategy || 'round-robin'; // round-robin | least-used
    this.healthCheck = options.healthCheck !== false;
    this.failover = options.failover !== false;
    this.healthCheckInterval = options.healthCheckInterval || 30000; // 30秒
    this.errorCooldown = options.errorCooldown || 30000; // 30秒冷却
    
    // 统计信息
    this.stats = {};
    
    // 轮询索引
    this.currentIndex = 0;
    
    // 定时健康检查
    if (this.healthCheck) {
      this.startHealthCheck();
    }
  }
  
  /**
   * 添加 API Key
   */
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
  
  /**
   * 移除 API Key
   */
  removeKey(apiKey) {
    const index = this.keys.indexOf(apiKey);
    if (index > -1) {
      this.keys.splice(index, 1);
      delete this.stats[apiKey];
    }
  }
  
  /**
   * 获取下一个可用的 API Key
   */
  getNextKey() {
    const healthyKeys = this.keys.filter(key => this.isKeyHealthy(key));
    
    if (healthyKeys.length === 0) {
      // 所有 key 都不健康，尝试获取最旧的
      if (this.keys.length > 0) {
        console.warn('[APIKeyManager] No healthy keys, returning least recently used');
        return this.keys[0];
      }
      return null;
    }
    
    let selectedKey;
    
    if (this.strategy === 'least-used') {
      // 选择使用次数最少的
      selectedKey = healthyKeys.reduce((min, key) => 
        this.stats[key].requests < this.stats[min].requests ? key : min
      );
    } else {
      // round-robin
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
  
  /**
   * 检查 Key 是否健康
   */
  isKeyHealthy(key) {
    const stat = this.stats[key];
    if (!stat) return false;
    if (!stat.healthy) {
      // 检查冷却是否结束
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
  
  /**
   * 标记错误
   */
  markError(apiKey, errorType) {
    if (!this.stats[apiKey]) return;

    this.stats[apiKey].errors++;
    this.stats[apiKey].lastUsed = Date.now();

    const et = String(errorType || '').toLowerCase();

    if (et === '429' || et.includes('429') || et.includes('rate limit')) {
      // 429: 临时限流，冷却后恢复
      if (this.failover) {
        this.stats[apiKey].healthy = false;
        this.stats[apiKey].cooldownUntil = Date.now() + this.errorCooldown;
        console.warn(`[APIKeyManager] Key rate limited: ****${String(apiKey).slice(-4)}, cooldown ${this.errorCooldown}ms`);
      }
    } else if (et === '401' || et.includes('401') || et.includes('unauthorized') || et.includes('invalid')) {
      // 401: 认证错误，永久禁用
      this.stats[apiKey].healthy = false;
      this.stats[apiKey].cooldownUntil = null;
      console.error(`[APIKeyManager] Key auth failed (permanent): ****${String(apiKey).slice(-4)}`);
    } else if (et === '403' || et.includes('403') || et.includes('forbidden')) {
      // 403: 权限错误，永久禁用
      this.stats[apiKey].healthy = false;
      this.stats[apiKey].cooldownUntil = null;
      console.error(`[APIKeyManager] Key forbidden (permanent): ****${String(apiKey).slice(-4)}`);
    }
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    const healthyKeys = this.keys.filter(key => this.isKeyHealthy(key));
    const totalRequests = this.keys.reduce((sum, key) => sum + (this.stats[key]?.requests || 0), 0);
    const totalErrors = this.keys.reduce((sum, key) => sum + (this.stats[key]?.errors || 0), 0);
    
    return {
      totalKeys: this.keys.length,
      healthyKeys: healthyKeys.length,
      totalRequests,
      totalErrors,
      keyDetails: this.stats
    };
  }
  
  /**
   * 启动健康检查（自动恢复冷却的 key）
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.keys.forEach(key => {
        if (!this.isKeyHealthy(key)) {
          this.isKeyHealthy(key); // 检查是否可以恢复
        }
      });
    }, this.healthCheckInterval);
  }
  
  /**
   * 停止健康检查
   */
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
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
    // 清理过期请求
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
    
    // API Key 管理器（多 Key 轮询 + 故障转移）
    this.keyManager = new APIKeyManager({
      strategy: options.keyStrategy || 'round-robin',
      healthCheck: options.healthCheck !== false,
      failover: options.failover !== false,
      errorCooldown: options.errorCooldown || 30000
    });
    
    // 添加 API Keys
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
    
    // 熔断器
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: options.circuitThreshold || 5,
      timeout: options.circuitReset || 30000
    });
    
    // 重试
    this.backoff = new ExponentialBackoff({
      maxRetries: options.maxRetries || 3,
      baseDelay: options.retryDelay || 1000
    });
    
    // 代理友好
    this.proxyConfig = {
      respectProxyRateLimit: options.respectProxyRateLimit !== false,
      respectRetryAfter: options.respectRetryAfter !== false,
      retryOnProxyError: options.retryOnProxyError !== false,
      proxyErrors: options.proxyErrors || [502, 503, 504]
    };
    
    this.headers = { ...options.headers };
    this.authHeader = options.authHeader || 'Authorization';
    this.authPrefix = options.authPrefix || 'Bearer';
  }
  
  /**
   * 添加 API Key
   */
  addAPIKey(apiKey) {
    this.keyManager.addKey(apiKey);
  }
  
  /**
   * 移除 API Key
   */
  removeAPIKey(apiKey) {
    this.keyManager.removeKey(apiKey);
  }
  
  /**
   * 获取 Key 统计
   */
  getKeyStats() {
    return this.keyManager.getStats();
  }
  
  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : this.baseURL + path;

    // 1. 限流（对整个请求做全局限流；多 key 只是认证层切换，不应绕开 QPS 约束）
    await this.rateLimiter.acquire();

    // 2. 获取连接
    const conn = await this.pool.acquire();

    let lastError;

    try {
      // 3. 熔断 + 重试：每次 attempt 都重新选 key，确保 429 能“同请求切换”
      const result = await this.circuitBreaker.execute(async () => {
        return await this.backoff.retry(async () => {
          const apiKey = this.keyManager.getNextKey();
          if (!apiKey) {
            const e = new Error('No available API keys');
            e.status = 401;
            throw e;
          }

          try {
            return await this.doRequest(url, {
              ...options,
              conn,
              apiKey,
            });
          } catch (err) {
            // 立刻标记 key 状态，避免 backoff 继续撞同一个 key
            const errorType = this.extractErrorType(err);
            this.keyManager.markError(apiKey, errorType);
            throw err;
          }
        });
      });

      return result;
    } catch (error) {
      lastError = error;
      throw error;
    } finally {
      // 4. 释放连接
      this.pool.release(conn);
    }
  }
  
  /**
   * 提取错误类型（尽量从 status/message 中识别）
   */
  extractErrorType(error) {
    const status = error?.status || error?.response?.status;
    if (status === 429) return '429';
    if (status === 401) return '401';
    if (status === 403) return '403';

    const msg = (error && error.message) ? error.message : String(error || '');
    const m = msg.toLowerCase();
    if (m.includes('429') || m.includes('rate limit')) return '429';
    if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid')) return '401';
    if (m.includes('403') || m.includes('forbidden')) return '403';
    return 'unknown';
  }

  /**
   * Key 脱敏：只展示后 4 位，避免泄露前缀
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
          'User-Agent': 'ReliableAPIClient/2.0',
          ...this.headers,
          ...options.headers
        },
        timeout: this.timeout
      };
      
      // 添加 API Key 认证
      if (options.apiKey) {
        requestOptions.headers[this.authHeader] = `${this.authPrefix} ${options.apiKey}`;
      }
      
      const req = client.request(requestOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // 代理限流检查
          if (this.proxyConfig.respectProxyRateLimit) {
            const remaining = res.headers['x-rate-limit-remaining'];
            if (remaining && parseInt(remaining) < 10) {
              console.warn('Proxy rate limit low:', remaining);
            }
          }
          
          // 429 / 401 / 403：让上层能感知并触发 key 状态更新
          if (res.statusCode === 429) {
            const retryAfter = res.headers['retry-after'];
            const e = new Error(`429 Rate limited${retryAfter ? ', retry after ' + retryAfter : ''}`);
            e.status = 429;
            e.retryAfter = retryAfter;
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
            data: data
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
module.exports.APIKeyManager = APIKeyManager;
module.exports.SlidingWindowRateLimiter = SlidingWindowRateLimiter;
module.exports.ConnectionPool = ConnectionPool;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.ExponentialBackoff = ExponentialBackoff;
