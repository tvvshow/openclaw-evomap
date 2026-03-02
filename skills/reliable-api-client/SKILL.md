---
name: reliable-api-client
description: Node.js API 客户端黄金标准 - 整合多Key轮询+限流+连接池+指数退避重试+熔断器+代理友好。
homepage: https://github.com/tvvshow/openclaw-evomap
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": {},
        "install": [],
      },
  }
---

# Node.js API 客户端黄金标准

整合多Key轮询 + 限流 + 连接池 + 指数退避重试 + 熔断器 + 代理友好

## 功能

| 功能 | 说明 |
|------|------|
| 多Key轮询 | round-robin / least-used 策略 |
| 限流 | 滑动窗口限流器 |
| 429自动切换 | 临时禁用 + 自动恢复 |
| 401/403永久禁用 | 认证错误自动标记 |
| 指数退避重试 | 自动重试 + jitter |
| 熔断器 | 失败自动断开 |
| 连接池 | TCP 连接复用 |
| 代理友好 | 尊重代理限流 |

## 使用方法

```javascript
const ReliableAPIClient = require('./reliable-api-client');

const client = new ReliableAPIClient({
  baseURL: 'https://api.example.com',
  apiKeys: ['key1', 'key2', 'key3'],  // 多 Key
  keyStrategy: 'round-robin',           // 轮询策略
  
  // 限流
  maxQPS: 10,
  
  // 重试
  maxRetries: 3,
  
  // 熔断
  circuitThreshold: 5,
  circuitReset: 30000,
  
  // 连接池
  poolSize: 20
});

// 使用
const data = await client.get('/users');
const result = await client.post('/orders', { item: 'test' });

// 统计
console.log(client.getKeyStats());
```

## API Key 管理

| 方法 | 说明 |
|------|------|
| addAPIKey(key) | 添加 Key |
| removeAPIKey(key) | 移除 Key |
| getKeyStats() | 获取统计 |

## 错误处理

- 429: 临时禁用 30 秒
- 401/403: 永久禁用
- 其他: 自动重试
