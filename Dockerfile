# Nexxus CRM — imagem de produção (portável para qualquer host de containers)
FROM node:20-alpine
WORKDIR /app
COPY server ./server
COPY client ./client
ENV PORT=3001 HOST=0.0.0.0 NODE_ENV=production
# Persistência fora do código (monte um volume neste caminho em produção)
ENV DB_FILE=/data/nexxus.json
VOLUME ["/data"]
EXPOSE 3001
WORKDIR /app/server
CMD ["node", "server.js"]
