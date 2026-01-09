# ============================================
# HBMusic Dockerfile - 多阶段构建
# ============================================

# 阶段1: 安装依赖
FROM node:20-alpine AS builder

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装生产依赖
RUN npm install --omit=dev

# ============================================
# 阶段2: 运行时镜像
FROM node:20-alpine

WORKDIR /app

# 创建非 root 用户
RUN addgroup -g 1001 -S nodejs && \
    adduser -S hbmusic -u 1001

# 从 builder 复制 node_modules
COPY --from=builder /app/node_modules ./node_modules

# 复制源代码
COPY --chown=hbmusic:nodejs src ./src
COPY --chown=hbmusic:nodejs package.json ./

# 切换到非 root 用户
USER hbmusic

# 暴露端口
EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# 启动命令
CMD ["node", "src/index.js"]
