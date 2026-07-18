# Retained capability compatibility

When eve continues to support an older extension capability epoch, add an
authored TypeScript fixture at `<capability>/v<epoch>.ts`. The fixture must use
the old contract in a representative way and continues to compile against the
current eve API whenever capability reports are checked.

`pnpm update:extension-contracts --bump <capability> --retain` updates the
support table and creates a marked scaffold at the required path. Replace that
scaffold with the representative example before rerunning
`pnpm update:extension-contracts` to create the new epoch report. Use
`--drop "reason"` instead when the current consumer cannot run the previous
epoch.

Keep the fixture immutable once merged. Structural compatibility is only one
part of consumer support, so retain focused runtime coverage for any behavior
that changed across the epoch boundary.
