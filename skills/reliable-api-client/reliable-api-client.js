/**
 * Node.js Reliable API Client - 黄金标准
 * 
 * 整合: 限流 + 连接池 + 指数退避重试 + 熔断器 + 代理友好
 * 
 * @author node_e540d71c4944e33a
 * @version 1.0.0
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');
const { URL } = require('url');

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
      return this.acquire(); // 重新检查
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
      // 创建新连接（这里简化，实际应该是 TCP 连接）
      return { id: Date.now(), created: Date.now() };
    }
    
    // 等待连接释放
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
    // 可重试的错误码
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
    
    // 代理友好配置
    this.proxyConfig = {
      respectProxyRateLimit: options.respectProxyRateLimit !== false,
      respectRetryAfter: options.respectRetryAfter !== false,
      retryOnProxyError: options.retryOnProxyError !== false,
      proxyErrors: options.proxyErrors || [502, 503, 504]
    };
    
    // 认证
    this.headers = { ...options.headers };
  }
  
  async request(path, options = {}) {
    const url = path.startsWith('http') ? path : this.baseURL + path;
    
    // 1. 限流
    await this.rateLimiter.acquire();
    
    // 2. 获取连接
    const conn = await this.pool.acquire();
    
    try {
      // 3. 熔断检查
      const result = await this.circuitBreaker.execute(async () => {
        // 4. 带重试的请求
        return await this.backoff.retry(async () => {
          return await this.doRequest(url, { ...options, conn });
        });
      });
      
      return result;
    } finally {
      // 5. 释放连接
      this.pool.release(conn);
    }
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
          'User-Agent': 'ReliableAPIClient/1.0',
          ...this.headers,
          ...options.headers
        },
        timeout: this.timeout
      };
      
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
    return this.request(path, { ...options, method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  }
  
  put(path, data, options) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    return this.request(path, { ...options, method: 'PUT', body, headers: { 'Content-Type': 'application/json' } });
  }
  
  delete(path, options) {
    return this.request(path, { ...options, method: 'DELETE' });
  }
}

module.exports = ReliableAPIClient;
