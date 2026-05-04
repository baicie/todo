#!/bin/bash
# scripts/deploy/docker.sh - Docker 部署脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

show_help() {
  echo "用法: ./docker.sh <命令> [选项]"
  echo ""
  echo "Docker 部署命令:"
  echo "  up           启动所有服务 (docker-compose up)"
  echo "  web          仅启动 Web 应用"
  echo "  backend      仅启动后端服务"
  echo "  down         停止所有服务"
  echo "  logs [服务]  查看服务日志"
  echo "  rebuild      重新构建并启动服务"
  echo ""
  echo "选项:"
  echo "  --help, -h   显示帮助信息"
}

check_docker() {
  if ! command -v docker &> /dev/null; then
    echo "错误: Docker 未安装."
    exit 1
  fi

  if ! docker info > /dev/null 2>&1; then
    echo "错误: Docker 未运行. 请启动 Docker Desktop."
    exit 1
  fi
}

case "${1:-}" in
  up)
    check_docker
    echo "启动所有服务..."
    cd "$ROOT_DIR"
    docker-compose up -d --build
    echo ""
    echo "✓ 部署完成!"
    echo "  Web 应用: http://localhost:8080"
    echo "  后端服务: http://localhost:3001"
    ;;
  web)
    check_docker
    echo "启动 Web 应用..."
    cd "$ROOT_DIR"
    docker-compose up -d --build web
    echo "✓ Web 应用已启动: http://localhost:8080"
    ;;
  backend)
    check_docker
    echo "启动后端服务..."
    cd "$ROOT_DIR"
    docker-compose up -d --build backend
    echo "✓ 后端服务已启动: http://localhost:3001"
    ;;
  down)
    check_docker
    echo "停止所有服务..."
    cd "$ROOT_DIR"
    docker-compose down
    echo "✓ 所有服务已停止"
    ;;
  logs)
    check_docker
    cd "$ROOT_DIR"
    if [[ -n "${2:-}" ]]; then
      docker-compose logs -f "$2"
    else
      docker-compose logs -f
    fi
    ;;
  rebuild)
    check_docker
    echo "重新构建所有服务..."
    cd "$ROOT_DIR"
    docker-compose down
    docker-compose up -d --build
    echo "✓ 重新构建完成!"
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
