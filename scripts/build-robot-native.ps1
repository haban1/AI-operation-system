$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
foreach ($component in @('client', 'admin-backend')) {
    $source = Join-Path $projectRoot "wechat-assistant/wechat-robot-$component"
    $binary = "wechat-robot-$component"
    docker run --rm --mount "type=bind,source=$source,target=/src" --mount type=volume,source=tianhe-go-mod,target=/go/pkg/mod --mount type=volume,source=tianhe-go-cache,target=/root/.cache/go-build -w /src -e GOPROXY=https://goproxy.cn,direct -e CGO_ENABLED=0 docker.m.daocloud.io/library/golang:1.25.8 go build -trimpath -o "/src/.build/$binary" .
    if ($LASTEXITCODE -ne 0) { throw "$component build failed" }
    $image = if ($component -eq 'client') { 'tianhe-wechat-client:native' } else { 'tianhe-wechat-admin:native' }
    docker build -f "$source/Dockerfile.native" -t $image $source
    if ($LASTEXITCODE -ne 0) { throw "$component image build failed" }
}
$source = Join-Path $projectRoot 'wechat-assistant/wechat-robot-admin-frontend'
$nativeConfigJson = docker compose --project-directory $projectRoot -f "$projectRoot/compose.yaml" -f "$projectRoot/compose.wechat.yaml" config --format json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the configured robot URL' }
$nativeConfig = $nativeConfigJson | ConvertFrom-Json
$robotAdminUri = [Uri]$nativeConfig.services.web.environment.WECHAT_ROBOT_ADMIN_URL
$robotHttpOrigin = if ($robotAdminUri.Scheme -eq 'http') { $robotAdminUri.GetLeftPart([UriPartial]::Authority) } else { '' }
docker run --rm --mount "type=bind,source=$source,target=/app" --mount type=volume,source=tianhe-robot-frontend-modules,target=/app/node_modules --mount type=volume,source=tianhe-pnpm-store,target=/pnpm/store -e "PUBLIC_ROBOT_HTTP_ORIGIN=$robotHttpOrigin" -w /app node:24.15.0-bookworm-slim sh -c 'npx --yes pnpm@8.15.9 config set store-dir /pnpm/store && npx --yes pnpm@8.15.9 install --frozen-lockfile && npx --yes pnpm@8.15.9 run build-types && npx --yes pnpm@8.15.9 lint && npx --yes pnpm@8.15.9 exec tsc --noEmit && npx --yes pnpm@8.15.9 build'
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
docker build -f "$source/Dockerfile.native" -t tianhe-wechat-ui:native $source
if ($LASTEXITCODE -ne 0) { throw 'Frontend image build failed' }
