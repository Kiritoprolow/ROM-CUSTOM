FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y ffmpeg cpulimit util-linux && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN chown -R 1000:1000 /app
USER 1000

ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
