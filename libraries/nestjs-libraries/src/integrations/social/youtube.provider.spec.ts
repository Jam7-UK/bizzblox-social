import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { getValidationSchemas } from '../../chat/validation.schemas.helper';
import { YoutubeProvider } from './youtube.provider';

describe('YouTube altered or synthetic content disclosure', () => {
  it('advertises an optional boolean in the provider settings', () => {
    const { dto } = new YoutubeProvider();
    const schema = getValidationSchemas()[dto.name];
    expect(schema.properties?.containsSyntheticMedia).toMatchObject({
      type: 'boolean',
    });
    expect(schema.required).not.toContain('containsSyntheticMedia');
  });

  it.each([true, false, undefined])(
    'sends the disclosure choice %s when starting the upload',
    async (choice) => {
      const provider = new YoutubeProvider();
      const request = vi.spyOn(provider, 'fetch').mockResolvedValue(
        new Response(null, {
          headers: { location: 'https://example.test/session' },
        })
      );
      const disclosure =
        choice === undefined ? {} : { containsSyntheticMedia: choice };
      await provider.postPending(
        'channel',
        'access',
        [
          {
            id: 'post',
            message: 'Description',
            media: [{ path: __filename, type: 'video' }],
            settings: {
              title: 'Test video',
              type: 'unlisted',
              selfDeclaredMadeForKids: 'yes',
              ...disclosure,
            },
          },
        ],
        undefined
      );
      const [, options] = request.mock.calls[0];
      expect(JSON.parse(String(options.body)).status).toEqual({
        privacyStatus: 'unlisted',
        selfDeclaredMadeForKids: true,
        ...disclosure,
      });
    }
  );
});
