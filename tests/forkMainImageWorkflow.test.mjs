import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/fork-main-image.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../Dockerfile.manager-server', import.meta.url), 'utf8');

describe('fork main image publication', () => {
  it('publishes immutable multi-arch images from the sussdorff fork', () => {
    for (const required of [
      'branches: [main]',
      'packages: write',
      'cancel-in-progress: false',
      'ghcr.io/sussdorff/cpa-manager-plus',
      'linux/amd64,linux/arm64',
      'type=raw,value=${{ github.sha }}',
      'type=raw,value=main',
      'org.opencontainers.image.source=https://github.com/sussdorff/CPA-Manager-Plus',
      'org.opencontainers.image.revision=${{ github.sha }}',
      'org.opencontainers.image.created=${{ steps.build_context.outputs.created }}',
      'GITHUB_REPOSITORY',
      'GITHUB_REF}" != "refs/heads/main',
      '^[0-9a-f]{40}$',
      'image_digest: ${{ steps.build.outputs.digest }}',
      'id: build',
      'GITHUB_STEP_SUMMARY',
      '"digest":"%s"',
      '"${{ steps.build.outputs.digest }}"',
    ]) {
      expect(workflow).toContain(required);
    }
    expect(workflow).not.toContain('ghcr.io/seakee/');
    expect(workflow).not.toContain('cancel-in-progress: true');
  });

  it('persists the complete OCI provenance set in the image config', () => {
    for (const required of [
      'ARG CREATED=unknown',
      'org.opencontainers.image.source="$SOURCE"',
      'org.opencontainers.image.revision="$REVISION"',
      'org.opencontainers.image.created="$CREATED"',
    ]) {
      expect(dockerfile).toContain(required);
    }
  });
});
