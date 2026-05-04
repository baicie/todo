#!/bin/bash
# scripts/deploy/packages.sh - 共享包发布脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

show_help() {
  echo "用法: ./packages.sh [选项] [版本]"
  echo ""
  echo "发布共享包到 npm."
  echo ""
  echo "参数:"
  echo "  版本   语义化版本号, 如 v0.1.0. 如果不提供, 将创建 patch 版本."
  echo ""
  echo "选项:"
  echo "  --dry-run    模拟运行, 不实际发布"
  echo "  --check       仅检查环境"
  echo "  --help, -h    显示帮助信息"
}

PACKAGES=(
  "packages/todo-model"
  "packages/hooks"
  "packages/ui"
  "packages/utils"
)

check_environment() {
  echo "检查发布环境..."

  if ! command -v pnpm &> /dev/null; then
    echo "错误: pnpm 未安装."
    exit 1
  fi
  echo "✓ pnpm $(pnpm --version)"

  if ! command -v git &> /dev/null; then
    echo "错误: git 未安装."
    exit 1
  fi
  echo "✓ git $(git --version)"

  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [[ "$branch" != "main" && "$branch" != "master" ]]; then
    echo "警告: 当前不在 main/master 分支 (当前: $branch)"
  fi

  echo ""
  echo "将发布的包:"
  for pkg in "${PACKAGES[@]}"; do
    if [[ -d "$ROOT_DIR/$pkg" ]]; then
      echo "  - $pkg"
    fi
  done
  echo ""
}

publish_packages() {
  local version="${1:-}"
  local dry_run="${2:-false}"

  cd "$ROOT_DIR"

  if [[ -n "$version" ]]; then
    echo "创建版本标签: $version"
    if [[ "$dry_run" == "false" ]]; then
      git tag "$version"
      git push origin "$version"
    else
      echo "[DRY-RUN] git tag $version"
      echo "[DRY-RUN] git push origin $version"
    fi
  else
    local current_version
    current_version=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
    local parts
    IFS='.' read -ra parts <<< "$current_version"
    local major="${parts[0]:-0}"
    local minor="${parts[1]:-0}"
    local patch="${parts[2]:-0}"
    ((patch++))
    version="v${major}.${minor}.${patch}"
    echo "自动生成版本: $version"
    if [[ "$dry_run" == "false" ]]; then
      git tag "$version"
      git push origin "$version"
    else
      echo "[DRY-RUN] git tag $version"
      echo "[DRY-RUN] git push origin $version"
    fi
  fi

  echo ""
  echo "✓ 发布完成!"
  echo "  GitHub Actions 将自动构建并发布以下包:"
  for pkg in "${PACKAGES[@]}"; do
    if [[ -d "$ROOT_DIR/$pkg" ]]; then
      echo "  - @baicie/$(basename "$pkg" | sed 's/todo-//')"
    fi
  done
}

case "${1:-}" in
  --check)
    check_environment
    ;;
  --dry-run)
    check_environment
    echo "=== DRY RUN ==="
    publish_packages "${2:-}" "true"
    ;;
  --help|-h)
    show_help
    ;;
  *)
    check_environment
    publish_packages "${1:-}" "false"
    ;;
esac
