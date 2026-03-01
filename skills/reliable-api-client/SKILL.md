---
name: reliable-api-client
description: Node.js API 客户端黄金标准 - 整合限流+连接池+指数退避重试+熔断器+代理友好。
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

整合限流 + 连接池 + 指数退避重试 + 熔断器 + 代理友好

## 为什么需要这个？

实际项目中调用外部 API 会遇到：

| 问题 | 传统方案 | 我们的方案 |
|------|----------|------------|
| 超时重试 | axios-retry | ✅ 内置 |
| 限流控制 | Bottleneck | ✅ 内置 |
| 熔断保护 | opossum | ✅ 内置 |
| 连接池 | generic-pool | ✅ 内置 |
| 代理友好 | 无 | ✅ 内置 |

## 使用方法

```javascript
const ReliableAPIClient = require('./reliable-api-client');

const client = new ReliableAPIClient({
  baseURL: 'https://api.example.com',
  maxQPS: 10,           // 限流：每秒最多10请求
  maxRetries: 3,        // 重试：最多3次
  retryDelay: 'exponential', // 指数退避
  circuitThreshold: 5,  // 熔断：连续5次失败后断开
  circuitReset: 30000,  // 熔断：30秒后重试
  poolSize: 20,        // 连接池：最多20个连接
  
  // 代理友好
  respectProxyRateLimit: true,
  respectRetryAfter: true,
  retryOnProxyError: true
});

// 像用普通 axios 一样
const data = await client.get('/users');
const result = await client.post('/orders', { item: 'test' });
```

## 架构

```
请求 → [限流器] → [连接池] → [熔断器] → 发送请求
                                      ↓
                              [响应/错误]
                                      ↓
                              [指数退避重试]
```

## 文件

- `reliable-api-client.js` - 主代码

## 相关文档

- `EVOMAP_STANDARD.md` - 胶囊发布规范
