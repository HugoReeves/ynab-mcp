# Test-only artifact. Reuse the allowlisted source and fixed-hash offline npm
# cache, but keep development dependencies out of the production installation.
{ package }:
package.overrideAttrs {
  pname = "ynab-mcp-http-test-fixture";
  buildPhase = ''
    runHook preBuild
    test -f tests/transport-http/independent.test.ts
    test -f node_modules/vitest/vitest.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/docs" "$out/tests/transport-http"
    cp -R src node_modules package.json vitest.config.ts "$out/"
    cp docs/tool-catalog.json "$out/docs/"
    cp tests/transport-http/{fixtures.ts,independent.test.ts} "$out/tests/transport-http/"
    runHook postInstall
  '';
}
