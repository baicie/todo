#!/bin/bash
# scripts/deploy/desktop.sh - 桌面应用构建脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"

show_help() {
  echo "用法: ./desktop.sh <命令> [平台] [选项]"
  echo ""
  echo "桌面应用构建命令 (Tauri):"
  echo ""
  echo "命令:"
  echo "  build        构建桌面应用"
  echo "  dev          开发模式运行"
  echo "  bundle       打包为安装程序"
  echo ""
  echo "平台:"
  echo "  windows      Windows 平台"
  echo "  macos        macOS 平台"
  echo "  linux        Linux 平台"
  echo "  all          所有支持平台 (默认)"
  echo ""
  echo "选项:"
  echo "  --debug      Debug 构建"
  echo "  --help, -h   显示帮助信息"
  echo ""
  echo "示例:"
  echo "  ./desktop.sh build windows"
  echo "  ./desktop.sh dev"
  echo "  ./desktop.sh bundle all"
}

check_environment() {
  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装."
    exit 1
  fi

  if [[ ! -d "$DESKTOP_DIR" ]]; then
    echo "错误: 桌面应用目录不存在: $DESKTOP_DIR"
    exit 1
  fi
}

build_desktop() {
  local platform="${1:-all}"
  local is_debug="${2:-false}"

  check_environment
  cd "$DESKTOP_DIR"

  echo "构建桌面应用..."
  echo "  平台: $platform"
  echo "  Debug: $is_debug"
  echo ""

  pnpm build

  if [[ "$is_debug" == "true" ]]; then
    pnpm tauri build --debug
  else
    pnpm tauri build
  fi

  echo ""
  echo "✓ 构建完成!"
  echo "  输出目录: $DESKTOP_DIR/src-tauri/target/release/"
}

dev_desktop() {
  check_environment
  cd "$DESKTOP_DIR"

  echo "启动开发模式..."
  pnpm tauri dev
}

bundle_desktop() {
  local platform="${1:-all}"

  check_environment
  cd "$DESKTOP_DIR"

  echo "打包安装程序..."
  pnpm tauri build --bundles "nsis,msi" --target "$platform"

  echo ""
  echo "✓ 打包完成!"
  echo "  安装程序位于: $DESKTOP_DIR/src-tauri/target/release/bundle/"
}

PLATFORM="all"
IS_DEBUG="false"
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    build|dev|bundle)
      COMMAND="$1"
      shift
      ;;
    windows|macos|linux|all)
      PLATFORM="$1"
      shift
      ;;
    --debug)
      IS_DEBUG="true"
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
    build_desktop "$PLATFORM" "$IS_DEBUG"
    ;;
  dev)
    dev_desktop
    ;;
  bundle)
    bundle_desktop "$PLATFORM"
    ;;
  *)
    echo "错误: 请指定命令 (build, dev, bundle)"
    show_help
    exit 1
    ;;
esac
