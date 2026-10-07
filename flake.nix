{
  description = "ynab-mcp development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (system:
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
