FROM node:20-alpine

WORKDIR /app
COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080
USER node

CMD ["node", "server.js"]
