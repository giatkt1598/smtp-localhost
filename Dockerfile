FROM node:24-alpine AS build

WORKDIR /app

COPY client/package.json client/package-lock.json ./client/
COPY server/package.json server/yarn.lock ./server/

RUN cd client && npm install
RUN cd server && npm install

COPY client ./client
COPY server ./server

RUN cd client && npm run build
RUN cd server && npm run build

FROM node:24-alpine AS runtime

WORKDIR /app/server

ENV HOST=0.0.0.0
ENV HTTP_PORT=18025
ENV SMTP_PORT=11025
ENV MAIL_DATA_DIR=/app/server/data/mailbox

COPY --from=build /app/server/dist ./dist
COPY --from=build /app/client/dist ../client/dist

RUN mkdir -p data/mailbox

EXPOSE 18025 11025

CMD ["node", "dist/index.js"]
