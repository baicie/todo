#!/bin/bash
# scripts/deploy/mobile.sh - 移动端构建脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
MOBILE_DIR="$ROOT_DIR/apps/mobile"

show_help() {
  echo "用法: ./mobile.sh <命令> [平台] [选项]"
  echo ""
  echo "移动端构建命令 (使用 EAS Build):"
  echo ""
  echo "命令:"
  echo "  build        构建移动应用"
  echo "  submit       提交到应用商店"
  echo "  update       更新 OTA 版本"
  echo ""
  echo "平台:"
  echo "  ios          iOS 平台"
  echo "  android      Android 平台"
  echo "  all          所有平台 (默认)"
  echo ""
  echo "选项:"
  echo "  --profile    指定 EAS profile (默认: production)"
  echo "  --local      本地构建"
  echo "  --help, -h   显示帮助信息"
  echo ""
  echo "示例:"
  echo "  ./mobile.sh build ios --profile production"
  echo "  ./mobile.sh build android"
  echo "  ./mobile.sh update all"
}

check_environment() {
  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装."
    exit 1
  fi

  if ! command -v eas &> /dev/null; then
    echo "警告: EAS CLI 未安装."
    echo "  安装命令: npm install -g eas-cli"
    exit 1
  fi

  if [[ ! -d "$MOBILE_DIR" ]]; then
    echo "错误: 移动端目录不存在: $MOBILE_DIR"
    exit 1
  fi
}

build_app() {
  local platform="${1:-all}"
  local profile="${2:-production}"
  local use_local="${3:-false}"

  check_environment
  cd "$MOBILE_DIR"

  local eas_args=(--platform "$platform" --profile "$profile")

  if [[ "$use_local" == "true" ]]; then
    eas_args+=(--local)
  fi

  echo "构建移动应用..."
  echo "  平台: $platform"
  echo "  Profile: $profile"
  echo "  本地构建: $use_local"
  echo ""

  pnpm build

  eas build "${eas_args[@]}"
}

submit_app() {
  local platform="${1:-all}"
  local profile="${2:-production}"

  check_environment
  cd "$MOBILE_DIR"

  echo "提交应用到商店..."
  eas submit --platform "$platform" --profile "$profile" --latest
}

update_ota() {
  local platform="${1:-all}"

  check_environment
  cd "$MOBILE_DIR"

  echo "更新 OTA 版本..."
  eas update --platform "$platform"
}

ARGS=()
PROFILE="production"
LOCAL_BUILD="false"
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    build|submit|update)
      COMMAND="$1"
      shift
      ;;
    ios|android|all)
      PLATFORM="$1"
      shift
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --local)
      LOCAL_BUILD="true"
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

PLATFORM="${PLATFORM:-all}"

case "$COMMAND" in
  build)
    build_app "$PLATFORM" "$PROFILE" "$LOCAL_BUILD"
    ;;
  submit)
    submit_app "$PLATFORM" "$PROFILE"
    ;;
  update)
    update_ota "$PLATFORM"
    ;;
  *)
    echo "错误: 请指定命令 (build, submit, update)"
    show_help
    exit 1
    ;;
esac
