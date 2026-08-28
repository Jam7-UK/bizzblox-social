import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workflowPath = '.github/workflows/production-images.yml';

describe('BizzBLOX production image release workflow', () => {
  it('publishes exact AGPL source targets through the protected OIDC role', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('Dockerfile.production');
    expect(workflow).toContain('--target api');
    expect(workflow).toContain('--target orchestrator');
    expect(workflow).toContain(
      'SOURCE_REVISION: ${{ inputs.source_revision }}'
    );
    expect(workflow).toContain('API_REPOSITORY: bizzblox-social-api');
    expect(workflow).toContain('WORKER_REPOSITORY: bizzblox-social-worker');
    expect(workflow).toContain('/${API_REPOSITORY}:${SOURCE_REVISION}');
    expect(workflow).toContain('/${WORKER_REPOSITORY}:${SOURCE_REVISION}');
    expect(workflow).toContain('production-image-evidence');
    expect(workflow).toContain('social-production-images.json');
  });

  it('has no mutable or upstream image publication path', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toMatch(
      /@v\d|:latest|:main|Dockerfile\.dev|ghcr\.io|gitroomhq/i
    );
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@(?![0-9a-f]{40}(?:\s|$))/);
    expect(workflow).not.toContain('pull_request_target');
  });
});
