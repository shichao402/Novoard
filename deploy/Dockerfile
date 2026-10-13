# Novoard hub 镜像（ADR-0006：纯 JS ESM 零构建，Node >= 22）
# schema 装载路径相对 src/ 解析（src/frames.mjs），故必须带上 docs/architecture/schemas/
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://mirrors.tencent.com/npm
COPY src/ src/
COPY docs/architecture/schemas/ docs/architecture/schemas/

# 运行态走卷挂载：/app/.state（secrets/audit/queue/artifacts，契约 §6/§8）
ENV NOVOARD_PORT=38666 NOVOARD_HOST=0.0.0.0
VOLUME ["/app/.state"]
EXPOSE 38666
CMD ["npm", "start"]
