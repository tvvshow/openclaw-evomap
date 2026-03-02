/**
 * Node.js Reliable API Client - 黄金标准 v3.1.0
 * 
 * 整合: 多Endpoint(各配Key) + 限流 + 连接池 + 指数退避重试 + 熔断器
 * 
 * @author node_e540d71c4944e33a
 * @version 3.1.0
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ==================== 0. Endpoint + Key 组合管理器 ====================
class EndpointKeyManager {
  constructor(options = {}) {
    this.entries = [];  // [{ endpoint, keys: [], strategy, ... }]
    this.strategy = options.strategy || 'priority'; // priority | round-robin | least-used
    this.healthCheck = options.healthCheck !== false;
    this.failover = options.failover !== false;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.errorCooldown = options.errorCooldown || 60000;
    
    this.currentIndex = 0;
    this.stats = {};
    
    if (this.healthCheck) {
      this.startHealthCheck();
    }
  }
  
  /**
   * 添加 Endpoint + Key 组合
   */
  addEntry(endpoint, keys = [], priority = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
    
    const existing = this.entries.find(e => e.endpoint === url);
    if (existing) {
      // 更新 keys
      keys.forEach(k => {
        if (!existing.keys.includes(k)) {
          existing.keys.push(k);
        }
      });
      existing.priority = Math.max(existing.priority, priority);
    } else {
      this.entries.push({
        endpoint: url,
        keys: [...keys],
        priority,
        keyIndex: 0,
        keyStrategy: 'round-robin'
      });
    }
    
    // 初始化统计
    if (!this.stats[url]) {
      this.stats[url] = {
        requests: 0,
        errors: 0,
        lastUsed: null,
        healthy: true,
        cooldownUntil: null,
        latency: null,
        keyStats: {}
      };
      keys.forEach(k => {
        this.stats[url].keyStats[k] = {
          requests: 0,
          errors: 0,
          healthy: true,
          cooldownUntil: null
        };
      });
    }
  }
  
  /**
   * 获取下一个可用的 Endpoint + Key
   */
  getNextEntry() {
    const healthyEntries = this.entries.filter(e => this.isEndpointHealthy(e.endpoint));
    
    if (healthyEntries.length === 0) {
      if (this.entries.length > 0) {
        console.warn('[EndpointKeyManager] No healthy entries, returning highest priority');
        const sorted = [...this.entries].sort((a, b) => b.priority - a.priority);
        const entry = sorted[0];
        return {
          endpoint: entry.endpoint,
          key: entry.keys[0] || null
        };
      }
      return { endpoint: null, key: null };
    }
    
    let selected;
    
    if (this.strategy === 'priority') {
      selected = healthyEntries.sort((a, b) => b.priority - a.priority)[0];
    } else if (this.strategy === 'least-used') {
      selected = healthyEntries.reduce((min, e) =>
        (this.stats[e.endpoint]?.requests || 0) < (this.stats[min.endpoint]?.requests || 0) ? e : min
      );
    } else {
      // round-robin
      let attempts = 0;
      while (attempts < healthyEntries.length) {
        const e = healthyEntries[this.currentIndex % healthyEntries.length];
        this.currentIndex++;
        if (this.isEndpointHealthy(e.endpoint)) {
          selected = e;
          break;
        }
        attempts++;
      }
    }
    
    if (!selected || !selected.keys.length) {
      return { endpoint: selected?.endpoint || null, key: null };
    }
    
    // 选择 Key
    const key = this.selectKey(selected);
    
    // 更新统计
    if (this.stats[selected.endpoint]) {
      this.stats[selected.endpoint].requests++;
      this.stats[selected.endpoint].lastUsed = Date.now();
      if (key && this.stats[selected.endpoint].keyStats[key]) {
        this.stats[selected.endpoint].keyStats[key].requests++;
      }
    }
    
    return { endpoint: selected.endpoint, key };
  }
  
  /**
   * 选择 Key
   */
  selectKey(entry) {
    const healthyKeys = entry.keys.filter(k => this.isKeyHealthy(entry.endpoint, k));
    
    if (healthyKeys.length === 0) {
      return entry.keys[0] || null;
    }
    
    if (entry.keyStrategy === 'least-used') {
      return healthyKeys.reduce((min, k) =>
        (this.stats[entry.endpoint].keyStats[k]?.requests || 0) <
        (this.stats[entry.endpoint].keyStats[min]?.requests || 0) ? k : min
      );
    } else {
      // round-robin
      const idx = entry.keyIndex % healthyKeys.length;
      entry.keyIndex++;
      return healthyKeys[idx];
    }
  }
  
  /**
   * 检查 Endpoint 是否健康
   */
  isEndpointHealthy(endpoint) {
    const stat = this.stats[endpoint];
    if (!stat) return false;
    if (!stat.healthy) {
      if (stat.cooldownUntil && Date.now() > stat.cooldownUntil) {
        stat.healthy = true;
        stat.cooldownUntil = null;
        console.log(`[EndpointKeyManager] Endpoint recovered: ${this.maskUrl(endpoint)}`);
        return true;
      }
      return false;
    }
    return true;
  }
  
  /**
   * 检查 Key 是否健康
   */
  isKeyHealthy(endpoint, key) {
    const stat = this.stats[endpoint]?.keyStats[key];
    if (!stat) return true; // 新 key 默认健康
    if (!stat.healthy) {
      if (stat.cooldownUntil && Date.now() > stat.cooldownUntil) {
        stat.healthy = true;
        stat.cooldownUntil = null;
        console.log(`[EndpointKeyManager] Key recovered: ${this.maskKey(key)}`);
        return true;
      }
      return false;
    }
    return true;
  }
  
  /**
   * 标记错误
   */
  markError(endpoint, key, errorType) {
    const endpointStat = this.stats[endpoint];
    if (!endpointStat) return;
    
    endpointStat.errors++;
    endpointStat.lastUsed = Date.now();
    
    const et = String(errorType).toLowerCase();
    
    // Endpoint 错误
    if (et.includes('429') || et.includes('rate limit')) {
      if (this.failover) {
        endpointStat.healthy = false;
        endpointStat.cooldownUntil = Date.now() + this.errorCooldown;
        console.warn(`[EndpointKeyManager] Endpoint rate limited: ${this.maskUrl(endpoint)}`);
      }
    } else if (et.includes('5')) {
      endpointStat.healthy = false;
      endpointStat.cooldownUntil = Date.now() + this.errorCooldown;
      console.warn(`[EndpointKeyManager] Endpoint 5xx: ${this.maskUrl(endpoint)}`);
    }
    
    // Key 错误
    if (key && endpointStat.keyStats[key]) {
      const keyStat = endpointStat.keyStats[key];
      keyStat.errors++;
      
      if (et.includes('429') || et.includes('rate limit')) {
        if (this.failover) {
          keyStat.healthy = false;
          keyStat.cooldownUntil = Date.now() + this.errorCooldown;
          console.warn(`[EndpointKeyManager] Key rate limited: ${this.maskKey(key)}`);
        }
      } else if (et.includes('401') || et.includes('unauthorized')) {
        keyStat.healthy = false;
        console.error(`[EndpointKeyManager] Key auth failed: ${this.maskKey(key)}`);
      } else if (et.includes('403') || et.includes('forbidden')) {
        keyStat.healthy = false;
        console.error(`[EndpointKeyManager] Key forbidden: ${this.maskKey(key)}`);
      }
    }
  }
  
  /**
   * 更新延迟
   */
  updateLatency(endpoint, latencyMs) {
    if (this.stats[endpoint]) {
      this.stats[endpoint].latency = latencyMs;
    }
  }
  
  /**
   * 脱敏
   */
  maskUrl(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}:***`;
    } catch { return '****'; }
  }
  
  maskKey(key) {
    if (!key) return '(null)';
    const s = String(key);
    if (s.length <= 8) return '****';
    return `****${s.slice(-4)}`;
  }
  
  /**
   * 获取统计
   */
  getStats() {
    return {
      totalEntries: this.entries.length,
      healthyEntries: this.entries.filter(e => this.isEndpointHealthy(e.endpoint)).length,
      details: this.stats
    };
  }
  
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.entries.forEach(e => this.isEndpointHealthy(e.endpoint));
    }, this.healthCheckInterval);
  }
  
  stopHealthCheck() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
  }
}

// ==================== 1. 限流器 ====================
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
  
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ==================== 2. 连接池 ====================
class ConnectionPool {
  constructor(options = {}) {
    this.maxSize = options.poolSize || 20;
    this.pool = [];
    this.waiting = [];
  }
  
  async acquire() {
    if (this.pool.length > 0) return this.pool.pop();
    if (this.pool.length < this.maxSize) return { id: Date.now() };
    return new Promise(r => this.waiting.push(r));
  }
  
  release(conn) {
    if (this.waiting.length > 0) this.waiting.shift()(conn);
    else if (this.pool.length < this.maxSize) this.pool.push(conn);
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
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    if (this.state === CircuitBreaker.STATES.HALF_OPEN) {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = CircuitBreaker.STATES.CLOSED;
        this.successes = 0;
      }
    }
  }
  
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.state === CircuitBreaker.STATES.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.state = CircuitBreaker.STATES.OPEN;
    }
  }
  
  getState() { return this.state; }
  reset() { this.state = CircuitBreaker.STATES.CLOSED; this.failures = 0; }
}

// ==================== 4. 指数退避 ====================
class ExponentialBackoff {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.jitter = options.jitter !== false;
  }
  
  async retry(fn) {
    let lastError;
    for (let i = 0; i < this.maxRetries; i++) {
      try { return await fn(); } 
      catch (e) {
        lastError = e;
        if (!this.shouldRetry(e)) throw e;
        await this.sleep(this.calculateDelay(i));
      }
    }
    throw lastError;
  }
  
  shouldRetry(e) {
    const codes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
    const status = e?.status || e?.response?.status;
    return (e.code && codes.includes(e.code)) || (status && [408,429,500,502,503,504].includes(status));
  }
  
  calculateDelay(attempt) {
    const d = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
    return d + (this.jitter ? Math.random() * 1000 : 0);
  }
  
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ==================== 5. 主客户端 ====================
class ReliableAPIClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL || '';
    this.timeout = options.timeout || 30000;
    
    // Endpoint + Key 组合管理器
    this.ekManager = new EndpointKeyManager({
      strategy: options.strategy || 'priority',
      healthCheck: options.healthCheck !== false,
      failover: options.failover !== false,
      errorCooldown: options.errorCooldown || 60000
    });
    
    // 添加组合
    if (options.entries && Array.isArray(options.entries)) {
      options.entries.forEach(e => {
        this.ekManager.addEntry(e.endpoint, e.keys, e.priority);
      });
    }
    
    // 兼容旧版
    if (options.endpoints && Array.isArray(options.endpoints)) {
      options.endpoints.forEach(ep => {
        const url = typeof ep === 'string' ? ep : ep.url;
        const prio = typeof ep === 'object' ? ep.priority : 0;
        this.ekManager.addEntry(url, options.apiKeys || [], prio);
      });
    }
    
    this.rateLimiter = new SlidingWindowRateLimiter({
      maxQPS: options.maxQPS || 10,
      windowMs: options.windowMs || 1000
    });
    
    this.pool = new ConnectionPool({ poolSize: options.poolSize || 20 });
    this.circuitBreakers = {};
    this.backoff = new ExponentialBackoff({
      maxRetries: options.maxRetries || 3,
      baseDelay: options.retryDelay || 1000
    });
    
    this.headers = { ...options.headers };
    this.authHeader = options.authHeader || 'Authorization';
    this.authPrefix = options.authPrefix || 'Bearer';
  }
  
  /**
   * 添加 Endpoint + Key 组合
   */
  addEntry(endpoint, keys, priority = 0) {
    this.ekManager.addEntry(endpoint, keys, priority);
    const url = endpoint.startsWith('http') ? endpoint : `https://${endpoint}`;
    if (!this.circuitBreakers[url]) {
      this.circuitBreakers[url] = new CircuitBreaker();
    }
  }
  
  getStats() {
    return this.ekManager.getStats();
  }
  
  async request(path, options = {}) {
    await this.rateLimiter.acquire();
    const conn = await this.pool.acquire();
    
    try {
      return await this.executeWithFailover(path, options, conn);
    } finally {
      this.pool.release(conn);
    }
  }
  
  async executeWithFailover(path, options, conn) {
    const entries = this.ekManager.entries;
    const maxAttempts = entries.length * (this.backoff.maxRetries + 1);
    let attempt = 0;
    let lastError;
    
    while (attempt < maxAttempts) {
      const { endpoint, key } = this.ekManager.getNextEntry();
      if (!endpoint) throw new Error('No available endpoints');
      
      if (!this.circuitBreakers[endpoint]) {
        this.circuitBreakers[endpoint] = new CircuitBreaker();
      }
      const cb = this.circuitBreakers[endpoint];
      
      if (!key) throw new Error('No available API keys');
      
      const url = path.startsWith('http') ? path : endpoint + path;
      attempt++;
      
      try {
        return await cb.execute(async () => {
          return await this.backoff.retry(async () => {
            try {
              return await this.doRequest(url, { ...options, conn, apiKey: key, endpoint });
            } catch (err) {
              this.ekManager.markError(endpoint, key, this.extractErrorType(err));
              throw err;
            }
          });
        });
      } catch (err) {
        lastError = err;
        if (err.message === 'Circuit breaker is OPEN') continue;
        if (attempt >= maxAttempts) throw err;
        await this.backoff.sleep(1000);
      }
    }
    
    throw lastError;
  }
  
  extractErrorType(e) {
    const s = e?.status || e?.response?.status;
    if (s === 429) return '429';
    if (s === 401) return '401';
    if (s === 403) return '403';
    const m = String(e?.message || e || '').toLowerCase();
    if (m.includes('429') || m.includes('rate limit')) return '429';
    if (m.includes('401') || m.includes('unauthorized')) return '401';
    if (m.includes('403') || m.includes('forbidden')) return '403';
    return 'unknown';
  }
  
  doRequest(url, options) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'ReliableAPIClient/3.1',
          ...this.headers,
          ...options.headers,
          ...(options.apiKey && { [this.authHeader]: `${this.authPrefix} ${options.apiKey}` })
        },
        timeout: this.timeout
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 429) { const e = new Error('429'); e.status = 429; reject(e); return; }
          if (res.statusCode === 401) { const e = new Error('401'); e.status = 401; reject(e); return; }
          if (res.statusCode === 403) { const e = new Error('403'); e.status = 403; reject(e); return; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      });
      
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('ETIMEDOUT')); });
      if (options.body) req.write(options.body);
      req.end();
    });
  }
  
  // 便捷方法
  get(path, options) { return this.request(path, { ...options, method: 'GET' }); }
  post(path, data, options) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return this.request(path, { ...options, method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  }
  put(path, data, options) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return this.request(path, { ...options, method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
  }
  delete(path, options) { return this.request(path, { ...options, method: 'DELETE' }); }
}

// 导出
module.exports = ReliableAPIClient;
module.exports.EndpointKeyManager = EndpointKeyManager;
module.exports.SlidingWindowRateLimiter = SlidingWindowRateLimiter;
module.exports.ConnectionPool = ConnectionPool;
module.exports.CircuitBreaker = CircuitBreaker;
module.exports.ExponentialBackoff = ExponentialBackoff;
