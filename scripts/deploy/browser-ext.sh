#!/bin/bash
# scripts/deploy/browser-ext.sh - 浏览器扩展构建脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
EXT_DIR="$ROOT_DIR/apps/browser-ext"

show_help() {
  echo "用法: ./browser-ext.sh <命令> [浏览器] [选项]"
  echo ""
  echo "浏览器扩展构建命令:"
  echo ""
  echo "命令:"
  echo "  build        构建扩展"
  echo "  package      打包扩展"
  echo "  watch        开发模式监听"
  echo ""
  echo "浏览器:"
  echo "  chrome       Chrome/Chromium"
  echo "  firefox      Firefox"
  echo "  edge         Microsoft Edge"
  echo "  all          所有浏览器 (默认)"
  echo ""
  echo "选项:"
  echo "  --help, -h   显示帮助信息"
  echo ""
  echo "示例:"
  echo "  ./browser-ext.sh build chrome"
  echo "  ./browser-ext.sh package firefox"
  echo "  ./browser-ext.sh watch"
}

check_environment() {
  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装."
    exit 1
  fi

  if [[ ! -d "$EXT_DIR" ]]; then
    echo "错误: 浏览器扩展目录不存在: $EXT_DIR"
    exit 1
  fi
}

build_ext() {
  local browser="${1:-all}"

  check_environment
  cd "$EXT_DIR"

  echo "构建浏览器扩展..."
  echo "  目标浏览器: $browser"
  echo ""

  pnpm build

  if [[ "$browser" == "chrome" || "$browser" == "all" ]]; then
    echo "✓ Chrome 扩展已构建: $EXT_DIR/dist/chrome/"
  fi
  if [[ "$browser" == "firefox" || "$browser" == "all" ]]; then
    echo "✓ Firefox 扩展已构建: $EXT_DIR/dist/firefox/"
  fi
  if [[ "$browser" == "edge" || "$browser" == "all" ]]; then
    echo "✓ Edge 扩展已构建: $EXT_DIR/dist/edge/"
  fi
}

package_ext() {
  local browser="${1:-all}"

  check_environment
  cd "$EXT_DIR"

  echo "打包浏览器扩展..."
  echo "  目标浏览器: $browser"
  echo ""

  pnpm build

  if [[ "$browser" == "firefox" || "$browser" == "all" ]]; then
    if command -v web-ext &> /dev/null; then
      web-ext build --source-dir dist/firefox --artifacts-dir dist/
      echo "✓ Firefox .xpi 已打包: $EXT_DIR/dist/"
    else
      echo "警告: web-ext CLI 未安装, 无法打包 Firefox 扩展"
      echo "  安装命令: npm install -g web-ext"
    fi
  fi
}

watch_ext() {
  check_environment
  cd "$EXT_DIR"

  echo "启动开发模式监听..."
  pnpm build:watch 2>/dev/null || pnpm build --watch
}

BROWSER="all"
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    build|package|watch)
      COMMAND="$1"
      shift
      ;;
    chrome|firefox|edge|all)
      BROWSER="$1"
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "错误: 未知参数 '$1'"
      show_help
      exit 1
      ;;
  esac
done

case "$COMMAND" in
  build)
    build_ext "$BROWSER"
    ;;
  package)
    package_ext "$BROWSER"
    ;;
  watch)
    watch_ext
    ;;
  *)
    echo "错误: 请指定命令 (build, package, watch)"
    show_help
    exit 1
    ;;
esac
