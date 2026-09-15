FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json
EXPOSE 8787
CMD ["npm", "run", "api"]

FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/server ./server
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json
CMD ["npm", "run", "worker"]

FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
