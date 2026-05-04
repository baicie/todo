#!/bin/bash
# scripts/deploy/deploy.sh - 主部署入口脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

show_help() {
  echo "用法: ./deploy.sh <命令> [选项]"
  echo ""
  echo "部署命令:"
  echo "  all           部署所有服务 (Docker Compose)"
  echo "  web           部署 Web 应用"
  echo "  backend       部署后端服务"
  echo "  packages      发布所有共享包"
  echo "  mobile        移动端构建 (需要 eas CLI)"
  echo "  desktop       桌面应用构建"
  echo "  browser-ext   浏览器扩展构建"
  echo "  vscode-ext    VSCode 扩展打包"
  echo ""
  echo "选项:"
  echo "  --help, -h    显示帮助信息"
  echo "  --check       仅检查环境，不执行部署"
  echo "  --dry-run     模拟运行，不实际执行"
  echo ""
  echo "示例:"
  echo "  ./deploy.sh all           # 部署所有服务"
  echo "  ./deploy.sh web          # 仅部署 Web 应用"
  echo "  ./deploy.sh packages     # 发布共享包"
}

check_environment() {
  echo "检查部署环境..."

  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装. 请访问 https://pnpm.io/installation"
    exit 1
  fi

  echo "✓ pnpm $(pnpm --version)"

  if [[ "$1" == "all" || "$1" == "web" || "$1" == "backend" ]]; then
    if ! command -v docker &> /dev/null; then
      echo "警告: Docker 未安装或未运行"
    else
      echo "✓ Docker $(docker --version)"
    fi
  fi

  if [[ "$1" == "mobile" ]]; then
    if ! command -v eas &> /dev/null; then
      echo "警告: EAS CLI 未安装 (需要用于移动端构建)"
      echo "  npm install -g eas-cli"
    else
      echo "✓ EAS CLI"
    fi
  fi

  echo ""
}

case "${1:-}" in
  all)
    "$SCRIPT_DIR/docker.sh" up
    ;;
  web)
    "$SCRIPT_DIR/docker.sh" web
    ;;
  backend)
    "$SCRIPT_DIR/docker.sh" backend
    ;;
  packages)
    "$SCRIPT_DIR/packages.sh"
    ;;
  mobile)
    "$SCRIPT_DIR/mobile.sh"
    ;;
  desktop)
    "$SCRIPT_DIR/desktop.sh"
    ;;
  browser-ext)
    "$SCRIPT_DIR/browser-ext.sh"
    ;;
  vscode-ext)
    "$SCRIPT_DIR/vscode-ext.sh"
    ;;
  --check)
    check_environment all
    ;;
  --help|-h)
    show_help
    ;;
  *)
    echo "错误: 未知命令 '$1'"
    echo ""
    show_help
    exit 1
    ;;
esac
