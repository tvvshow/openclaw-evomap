#!/usr/bin/env python3
"""
Auto Debug Framework - 统一错误分类与报告层
最小实现：捕获 → 分类 → 报告
"""

import os
import sys
import json
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, Callable
from functools import wraps

# 错误码分类规则
ERROR_CODES = {
    'RATE_LIMIT': {
        'patterns': ['429', 'Too Many Requests', 'rate_limit', 'rate limit'],
        'code': '429'
    },
    'TIMEOUT': {
        'patterns': ['timeout', 'timed out', 'ETIMEDOUT', 'max-time'],
        'code': 'timeout'
    },
    'CONNECTION_REFUSED': {
        'patterns': ['ECONNREFUSED', 'Connection refused', 'connect failed'],
        'code': 'conn_refused'
    },
    'JSON_EXTRA_DATA': {
        'patterns': ['Extra data: line', 'json_extra_data'],
        'code': 'json_extra_data'
    },
    'JSON_PARSE': {
        'patterns': ['JSONDecodeError', 'json.decoder', 'Expecting value'],
        'code': 'json_parse'
    },
    'SHELL_EOF': {
        'patterns': ['EOFError', 'shell EOF', 'Unexpected end'],
        'code': 'shell_eof'
    },
    'AUTH_ERROR': {
        'patterns': ['401', '403', 'Unauthorized', 'Forbidden', 'invalid token'],
        'code': 'auth_error'
    },
    'NETWORK_ERROR': {
        'patterns': ['Network is unreachable', 'Connection reset', 'SSL'],
        'code': 'network_error'
    },
    'FILE_NOT_FOUND': {
        'patterns': ['ENOENT', 'No such file', 'file not found'],
        'code': 'file_not_found'
    },
    'PERMISSION_DENIED': {
        'patterns': ['EACCES', 'permission denied', 'Access denied'],
        'code': 'permission_denied'
    },
    'UNEXPECTED_EOF': {
        'patterns': ['unexpected EOF', 'Unexpected end', 'EOFError', 'heredoc'],
        'code': 'unexpected_eof'
    },
    'JSON_EXTRA_DATA': {
        'patterns': ['JSONDecodeError: Extra data', 'Extra data: line', 'json_extra_data'],
        'code': 'json_extra_data'
    },
    'UNKNOWN': {
        'patterns': [],
        'code': 'unknown'
    }
}

class AutoDebugReport:
    """结构化调试报告"""
    
    def __init__(self, task_name: str):
        self.task_name = task_name
        self.timestamp = datetime.now().isoformat()
        self.error_code = 'unknown'
        self.error_message = ''
        self.root_cause = ''
        self.fix_actions = []
        self.missing_info = []
        self.stack_trace = ''
        self.context = {}
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            'task_name': self.task_name,
            'timestamp': self.timestamp,
            'error_code': self.error_code,
            'error_message': self.error_message[:500],  # 截断防超长
            'root_cause': self.root_cause,
            'fix_actions': self.fix_actions,
            'missing_info': self.missing_info,
            'stack_trace': self.stack_trace[:1000],
            'context': self.context
        }
    
    def to_summary(self) -> str:
        """一行摘要"""
        return f"[{self.error_code}] {self.task_name}: {self.root_cause[:50]}"
    
    def to_markdown(self) -> str:
        """Markdown 格式报告"""
        md = f"""# Auto Debug Report

## 基本信息
- **任务**: {self.task_name}
- **时间**: {self.timestamp}
- **错误码**: `{self.error_code}`

## 错误信息
```
{self.error_message[:500]}
```

## 根因分析
{self.root_cause}

## 修复动作
"""
        for i, action in enumerate(self.fix_actions, 1):
            md += f"{i}. {action}\n"
        
        if self.missing_info:
            md += f"\n## 缺失信息\n"
            for info in self.missing_info:
                md += f"- {info}\n"
        
        if self.stack_trace:
            md += f"\n## 堆栈\n```\n{self.stack_trace[:1000]}\n```\n"
        
        return md


class AutoDebug:
    """统一错误捕获与分类框架"""
    
    def __init__(self, reports_dir: str = 'reports/auto_debug'):
        self.reports_dir = Path(reports_dir)
        self.reports_dir.mkdir(parents=True, exist_ok=True)
    
    def classify_error(self, error: Exception, stderr: str = '', stdout: str = '') -> str:
        """根据错误消息和输出分类错误码"""
        error_str = str(error)
        combined = f"{error_str} {stderr} {stdout}".lower()
        
        for category, config in ERROR_CODES.items():
            if category == 'UNKNOWN':
                continue
            for pattern in config['patterns']:
                if pattern.lower() in combined:
                    return config['code']
        
        return 'unknown'
    
    def analyze_root_cause(self, error_code: str, error_message: str, context: Dict = None) -> tuple:
        """根因分析 + 修复建议"""
        context = context or {}
        
        # error_code 映射到分析类别
        code_to_category = {
            '429': 'rate_limit',
            'timeout': 'timeout',
            'conn_refused': 'conn_refused',
            'json_extra_data': 'json_extra_data',
            'json_parse': 'json_parse',
            'shell_eof': 'shell_eof',
            'unexpected_eof': 'unexpected_eof',
            'auth_error': 'auth_error',
            'network_error': 'network_error',
            'file_not_found': 'file_not_found',
            'permission_denied': 'permission_denied',
            'unknown': 'unknown'
        }
        
        category = code_to_category.get(error_code, 'unknown')
        
        rca_map = {
            'rate_limit': (
                "检测到 API 限频，触发了服务端流量控制",
                ["读取响应头 next_request_at", "等待指定时间 + 随机抖动", "检查是否有足够预算继续"],
                ["当前请求是否真的必要", "是否有备用 API key"]
            ),
            'timeout': (
                "网络请求超时，可能是网络不稳定或服务端响应慢",
                ["增加超时时间", "检查网络连接", "添加重试机制"],
                ["服务端状态", "具体超时时间"]
            ),
            'conn_refused': (
                "连接被拒绝，可能是服务端未启动或网络不通",
                ["检查服务端是否运行", "检查防火墙/代理设置", "确认端口正确"],
                ["服务端状态", "连接地址"]
            ),
            'json_parse': (
                "JSON 解析失败，响应不是有效 JSON",
                ["检查响应编码", "打印原始响应排查", "添加容错处理"],
                ["原始响应内容"]
            ),
            'shell_eof': (
                "Shell 脚本提前结束，可能是脚本错误或超时",
                ["检查脚本语法", "增加脚本超时时间", "查看脚本输出"],
                ["脚本退出码", "脚本输出"]
            ),
            'auth_error': (
                "认证失败，token 可能过期或无效",
                ["刷新 token", "检查 token 格式", "确认权限"],
                ["token 有效期", "具体权限需求"]
            ),
            'network_error': (
                "网络错误，可能是 DNS/SSL/路由问题",
                ["检查网络连接", "验证 SSL 证书", "尝试 IPv4"],
                ["网络环境", "DNS 解析"]
            ),
            'file_not_found': (
                "文件不存在，可能是路径错误或文件被删除",
                ["检查文件路径", "确认文件存在", "使用绝对路径"],
                ["期望路径", "实际路径"]
            ),
            'permission_denied': (
                "权限不足，无法访问文件或执行操作",
                ["检查文件权限", "确认用户权限", "使用 sudo"],
                ["当前用户", "目标权限"]
            ),
            'unexpected_eof': (
                "脚本/输出解析遇到 unexpected EOF，可能是 heredoc、引号不闭合",
                ["检查脚本/模板字符串引号是否闭合", "检查 heredoc 结束标记是否正确", "改用唯一结束标记如 EOF_MD", "避免 shell 拼接，改用 Python/Node 写文件"],
                ["原始脚本内容", "引号配对情况"]
            ),
            'json_extra_data': (
                "JSON 解析遇到 Extra data，可能是 JSONL/多段 JSON 拼接",
                ["判断是否为 JSONL：按行逐条 json.loads", "检查是否多 JSON 直接拼接", "确保只写 response body，不混入进度输出"],
                ["原始文件内容", "是否 JSONL 格式"]
            ),
            'unknown': (
                "未知错误，需要人工排查",
                ["查看完整错误信息", "检查日志", "搜索错误码"],
                ["完整堆栈", "复现步骤"]
            )
        }
        
        return rca_map.get(category, rca_map['unknown'])
    
    def capture(self, error: Exception, task_name: str, context: Dict = None, 
                stderr: str = '', stdout: str = '') -> AutoDebugReport:
        """捕获错误并生成报告"""
        report = AutoDebugReport(task_name)
        report.error_message = str(error)[:500]
        report.stack_trace = traceback.format_exc()
        report.context = context or {}
        
        # 分类
        report.error_code = self.classify_error(error, stderr, stdout)
        
        # 根因分析
        root_cause, fix_actions, missing_info = self.analyze_root_cause(
            report.error_code, report.error_message, context
        )
        report.root_cause = root_cause
        report.fix_actions = fix_actions
        report.missing_info = missing_info
        
        # 保存报告
        self._save_report(report)
        
        return report
    
    def _save_report(self, report: AutoDebugReport):
        """保存报告到文件"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"{report.task_name}_{report.error_code}_{timestamp}.json"
        filepath = self.reports_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(report.to_dict(), f, ensure_ascii=False, indent=2)
        
        # 同时保存 markdown 版本
        md_filename = filename.replace('.json', '.md')
        md_filepath = self.reports_dir / md_filename
        with open(md_filepath, 'w', encoding='utf-8') as f:
            f.write(report.to_markdown())
        
        print(f"📋 Debug report saved: {filepath}")
    
    def wrap(self, task_name: str):
        """装饰器：自动捕获函数错误"""
        def decorator(func):
            @wraps(func)
            def wrapper(*args, **kwargs):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    report = self.capture(e, task_name, context={
                        'args': str(args)[:200],
                        'kwargs': str(kwargs)[:200]
                    })
                    print(f"❌ {report.to_summary()}")
                    raise
            return wrapper
        return decorator
    
    def append_to_events(self, report: AutoDebugReport, events_file: str = 'RECENT_EVENTS.md'):
        """追加到事件日志"""
        events_path = Path(events_file)
        if not events_path.exists():
            events_path.write_text("# Recent Events\n\n", encoding='utf-8')
        
        with open(events_path, 'a', encoding='utf-8') as f:
            f.write(f"\n## {report.timestamp}\n")
            f.write(f"- {report.to_summary()}\n")


# 便捷函数
def quick_debug(task_name: str, error: Exception, **context) -> AutoDebugReport:
    """快速调试入口"""
    debug = AutoDebug()
    return debug.capture(error, task_name, context)


if __name__ == '__main__':
    # 测试
    debug = AutoDebug()
    
    # 测试错误分类
    test_errors = [
        Exception("429 Too Many Requests"),
        Exception("Connection timeout after 20s"),
        Exception("JSONDecodeError: Expecting value"),
        Exception("401 Unauthorized: invalid token")
    ]
    
    print("🧪 Error Classification Test:\n")
    for err in test_errors:
        code = debug.classify_error(err)
        print(f"  {err} → {code}")
