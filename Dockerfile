ARG NODE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
ARG BUSYBOX_IMAGE=busybox:1.38.0-musl@sha256:32b5cdad7cce41dfd53d0ae06baebcf8357a147ee7694dc706911c373bc30c37

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM ${BUSYBOX_IMAGE}
COPY --from=build /src/dist /srv
COPY ops/health /srv/health

USER 65532:65532
EXPOSE 8080

CMD ["httpd", "-f", "-p", "8080", "-h", "/srv"]
