# Image de production de `catalog-manga`. Multi-stage sur base Red Hat UBI 9, alignee sur celle du
# monolithe (`../../../acervatim-backend/Dockerfile`) : meme famille OS entre builder et
# runtime, donc le client Prisma genere ici (engine rhel-openssl-3.0.x) est directement
# utilisable dans l'image finale. Multi-arch amd64 + arm64.
#
# Build (depuis la racine backend-services/) :
#   podman build -f catalog-manga/Dockerfile -t localhost/acervatim-catalog-manga:0.1.0 .
#
# Cross-arch depuis x86 : ajouter `--platform linux/arm64` (necessite qemu-user-static +
# binfmt). Prisma genere l'engine de la plateforme du BUILD : builder pour l'architecture de
# deploiement, jamais copier une image cross-arch.
#
# **Ce conteneur n'execute aucune migration** : le CLI prisma est une devDependency, absente
# de l'image runtime. Les migrations de tous les services sont jouees par une image dediee et
# unique - `deploy/Dockerfile.migrate` -, lancee en initContainer par le pod Kubernetes.

# ---------- Etape 1 : build (dependances completes + compilation) ----------
FROM registry.access.redhat.com/ubi9/nodejs-24:latest AS build

WORKDIR /opt/app-root/src

COPY --chown=1001:0 catalog-manga/package.json catalog-manga/package-lock.json ./
RUN npm ci --ignore-scripts

COPY --chown=1001:0 catalog-manga/prisma ./prisma
RUN npx prisma generate

# `catalog-core` est compile DANS ce service, pas installe comme paquet : c'est ce qui lui
# permet d'etre type contre le client Prisma genere ci-dessus. Il doit donc etre place a
# l'interieur de l'arborescence (`/opt/app-root/src/catalog-core`), exactement comme en
# developpement - voir ../catalog-core/README.md, la mecanique n'est pas evidente.
COPY --chown=1001:0 catalog-core ./catalog-core

COPY --chown=1001:0 catalog-manga/tsconfig.json catalog-manga/tsconfig.build.json catalog-manga/nest-cli.json ./
COPY --chown=1001:0 catalog-manga/src ./src
RUN npm run build

# ---------- Etape 2 : dependances de production uniquement ----------
FROM registry.access.redhat.com/ubi9/nodejs-24:latest AS deps-prod

WORKDIR /opt/app-root/src

COPY --chown=1001:0 catalog-manga/package.json catalog-manga/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /opt/app-root/src/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /opt/app-root/src/node_modules/@prisma/client ./node_modules/@prisma/client

# ---------- Etape finale : runtime minimal ----------
FROM registry.access.redhat.com/ubi9/nodejs-24-minimal:latest AS runtime

ENV NODE_ENV=production \
    PORT=3170

USER 0
RUN mkdir -p /app && chown 1001:0 /app
USER 1001

WORKDIR /app

COPY --from=deps-prod --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --from=build --chown=1001:0 /opt/app-root/src/dist ./dist
COPY --chown=1001:0 catalog-manga/package.json ./

EXPOSE 3170

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# `dist/` est decale d'un cran pour les catalogs : la racine de compilation est
# /opt/app-root/src (elle contient `src/` ET `catalog-core/`), pas /opt/app-root/src/src.
CMD ["node", "dist/src/main"]
