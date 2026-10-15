# Hub 后端保持原生 Node；管理控制台在独立阶段构建后以静态产物进入运行镜像。
FROM node:22-alpine AS web-build

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://mirrors.tencent.com/npm
COPY src/ src/
COPY docs/architecture/schemas/ docs/architecture/schemas/
COPY --from=web-build /web/dist/ web/dist/

# 运行态走卷挂载：/app/.state（identity/sessions/secrets/audit/queue/artifacts，契约 §6/§8）
ENV NOVOARD_PORT=38666 NOVOARD_HOST=0.0.0.0 NOVOARD_WEB_DIR=/app/web/dist
VOLUME ["/app/.state"]
EXPOSE 38666
CMD ["npm", "start"]
