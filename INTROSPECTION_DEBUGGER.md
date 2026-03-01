# AI Agent 自省调试框架

已部署到 OpenClaw 工作区。

## 文件位置

```
/root/.openclaw/workspace/introspection-debugger.js
```

## 使用方法

### 1. 在 Node.js 项目中引入

```javascript
const IntrospectionDebugger = require('./introspection-debugger');

// 创建实例
const debugger = new IntrospectionDebugger({
  workspace: process.cwd(),              // 工作目录
  maxHistorySize: 100,                 // 最大历史记录数
  notificationHook: null                // 通知钩子 (可选)
});

// 监听错误事件
debugger.on('error', (errorInfo) => {
  console.error('[Introspection] Error captured:', errorInfo.id);
});

// 监听报告事件
debugger.on('report', (report) => {
  console.log('[Introspection] Report:', report.recommendation);
});

// 手动捕获错误
try {
  // 你的代码
} catch (e) {
  debugger.catch(e, { source: 'my-code' });
}
```

### 2. 配置通知 (可选)

```javascript
// 方式1: Webhook
const debugger = new IntrospectionDebugger({
  notificationHook: 'https://your-webhook-url.com/notify'
});

// 方式2: 自定义函数
const debugger = new IntrospectionDebugger({
  notificationHook: async (report) => {
    await sendTelegramMessage(report);
  }
});
```

### 3. 查看统计

```javascript
const stats = debugger.getStats();
console.log(stats);
// 输出: { totalErrors: 10, totalFixes: 8, categories: {...}, autoFixRate: 0.8 }
```

## 功能

| 功能 | 描述 |
|------|------|
| 全局错误捕获 | 自动拦截 uncaughtException 和 unhandledRejection |
| 根因分析 | 基于规则库匹配常见错误 (80%+) |
| 自动修复 | 尝试自动创建文件、修复权限、安装依赖 |
| 报告生成 | 生成结构化自省报告 |
| 人类通知 | 无法自动修复时通知人类 |

## 支持的错误类型

- 文件缺失 (ENOENT)
- 权限错误 (EACCES)
- 模块缺失 (MODULE_NOT_FOUND)
- 连接超时 (ETIMEDOUT)
- 限流 (429)
- 服务器错误 (500-504)
- 内存溢出 (OOM)
- 进程被终止 (SIGKILL)
- 认证错误 (401/403)
- 等等...

## 与 OpenClaw 集成

在 OpenClaw 启动时加载:

```javascript
// 在 OpenClaw 启动脚本中添加
const IntrospectionDebugger = require('./introspection-debugger');

global.agentDebugger = new IntrospectionDebugger({
  workspace: '/root/.openclaw/workspace',
  notificationHook: (report) => {
    // 发送通知给主人
    message.send({
      to: '主人',
      message: `🤖 自省报告: ${report.analysis.category} - ${report.recommendation.message}`
    });
  }
});
```
