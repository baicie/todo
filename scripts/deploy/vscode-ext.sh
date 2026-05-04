#!/bin/bash
# scripts/deploy/vscode-ext.sh - VSCode 扩展构建脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VSCODE_DIR="$ROOT_DIR/apps/vscode-ext"

show_help() {
  echo "用法: ./vscode-ext.sh <命令> [选项]"
  echo ""
  echo "VSCode 扩展构建命令:"
  echo ""
  echo "命令:"
  echo "  build        构建扩展"
  echo "  package      打包为 .vsix"
  echo "  publish      发布到 Marketplace"
  echo "  watch        开发模式监听"
  echo ""
  echo "选项:"
  echo "  --help, -h   显示帮助信息"
  echo ""
  echo "示例:"
  echo "  ./vscode-ext.sh build"
  echo "  ./vscode-ext.sh package"
  echo "  ./vscode-ext.sh publish"
}

check_environment() {
  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装."
    exit 1
  fi

  if [[ ! -d "$VSCODE_DIR" ]]; then
    echo "错误: VSCode 扩展目录不存在: $VSCODE_DIR"
    exit 1
  fi
}

build_ext() {
  check_environment
  cd "$VSCODE_DIR"

  echo "构建 VSCode 扩展..."
  pnpm build

  echo ""
  echo "✓ 扩展已构建: $VSCODE_DIR/out/"
}

package_ext() {
  check_environment
  cd "$VSCODE_DIR"

  echo "打包 VSCode 扩展..."
  pnpm package

  echo ""
  echo "✓ 扩展已打包: $VSCODE_DIR/*.vsix"
  echo "  上传此文件到 VSCode Marketplace"
}

publish_ext() {
  check_environment
  cd "$VSCODE_DIR"

  echo "发布到 VSCode Marketplace..."
  echo "  确保已登录: vsce login <publisher>"
  echo ""

  pnpm publish

  echo ""
  echo "✓ 已发布!"
}

watch_ext() {
  check_environment
  cd "$VSCODE_DIR"

  echo "启动开发模式监听..."
  pnpm watch
}

case "${1:-}" in
  build)
    build_ext
    ;;
  package)
    package_ext
    ;;
  publish)
    publish_ext
    ;;
  watch)
    watch_ext
    ;;
  --help|-h)
    show_help
    ;;
  *)
    echo "错误: 请指定命令 (build, package, publish, watch)"
    show_help
    exit 1
    ;;
esac
