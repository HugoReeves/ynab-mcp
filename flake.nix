{
  description = "ynab-mcp package, offline checks, NixOS service, and development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      # Preserve the original shell outputs. The pinned upstream no longer
      # provides legacyPackages.x86_64-darwin; see docs/nix.md.
      devSystems = systems ++ [ "x86_64-darwin" ];
      forSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          package = pkgs.callPackage ./pkgs/ynab-mcp { };
        in
        {
          default = package;
          ynab-mcp = package;
        });

      nixosModules.default = { pkgs, lib, ... }: {
        imports = [ ./modules/nixos/ynab-mcp.nix ];
        services.ynab-mcp.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.ynab-mcp;
      };

      checks = forSystems (system:
        import ./checks {
          pkgs = nixpkgs.legacyPackages.${system};
          package = self.packages.${system}.ynab-mcp;
          module = self.nixosModules.default;
        });

      devShells = nixpkgs.lib.genAttrs devSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_24
              git
              direnv
              pre-commit
              python3Packages.pre-commit-hooks
            ];

            shellHook = ''
              if [ -d .git ]; then
                pre-commit install >&2
              fi
            '';
          };
        });
    };
}
