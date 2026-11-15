# The relay as a container image, from the published npm package.
#
#   docker build -t inceptionjs-relay [--build-arg VERSION=x.y.z] deploy/relay
#   docker run -p 5001:5001 -e INCEPTION_RELAY_SECRET=... inceptionjs-relay \
#     --origin https://app.example.com
#
# Arguments after the image name go to `inceptionjs relay` (--metrics,
# --log json, --tls-cert/--tls-key with the files mounted, ...). It listens on
# all interfaces, which requires INCEPTION_RELAY_SECRET.
FROM node:22-alpine
ARG VERSION=latest
RUN npm install --global --omit=dev "inceptionjs@${VERSION}" && npm cache clean --force
USER node
EXPOSE 5001
# Plain HTTP on the container's own loopback; with --tls-cert, probe /healthz
# from your orchestrator instead.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:5001/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# A stop signal drains open sessions for --drain-seconds (30) first: give
# `docker stop` at least that long (--time 35).
STOPSIGNAL SIGTERM
ENTRYPOINT ["inceptionjs", "relay", "--host", "0.0.0.0", "--port", "5001"]
