import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTIVE_LIMITS,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplateMessage,
} from './meta-api';

// All assertions in this file run BEFORE the network call. We stub fetch
// to a never-resolving mock so a test that accidentally falls through to
// the request body would hang (and fail) rather than silently hit
// graph.facebook.com.
const neverFetch = () =>
  new Promise<Response>(() => {
    /* intentionally never resolves */
  });

const BASE_ARGS = {
  phoneNumberId: 'test-phone',
  accessToken: 'test-token',
  to: '1234567890',
  bodyText: 'Body text',
} as const;

const TEMPLATE_BASE_ARGS = {
  phoneNumberId: 'test-phone',
  accessToken: 'test-token',
  to: '1234567890',
  templateName: 'auction_invite',
  language: 'ar',
} as const;

describe('sendTemplateMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends body params with an image header component', async () => {
    let captured: { body: unknown } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.TEMPLATE' }] }),
          { status: 200 }
        );
      })
    );

    const result = await sendTemplateMessage({
      ...TEMPLATE_BASE_ARGS,
      header: {
        type: 'image',
        media_url: 'https://example.com/header.jpg',
      },
      params: ['Areej', 'Auction'],
    });

    expect(result).toEqual({ messageId: 'wamid.TEMPLATE' });
    expect(captured!.body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '1234567890',
      type: 'template',
      template: {
        name: 'auction_invite',
        language: { code: 'ar' },
        components: [
          {
            type: 'header',
            parameters: [
              {
                type: 'image',
                image: { link: 'https://example.com/header.jpg' },
              },
            ],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Areej' },
              { type: 'text', text: 'Auction' },
            ],
          },
        ],
      },
    });
  });

  it('sends dynamic URL button parameters', async () => {
    let components: unknown[] | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        components = body.template.components;
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.BUTTON' }] }),
          { status: 200 }
        );
      })
    );

    await sendTemplateMessage({
      ...TEMPLATE_BASE_ARGS,
      buttonParams: [{ type: 'url', index: 0, text: 'auction-123' }],
    });

    expect(components).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'auction-123' }],
      },
    ]);
  });

  it('sends a document header filename', async () => {
    let components: unknown[] | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        components = body.template.components;
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.DOCUMENT' }] }),
          { status: 200 }
        );
      })
    );

    await sendTemplateMessage({
      ...TEMPLATE_BASE_ARGS,
      header: {
        type: 'document',
        media_url: 'https://example.com/files/catalogue.pdf',
        filename: 'Auction Catalogue.pdf',
      },
    });

    expect(components).toEqual([
      {
        type: 'header',
        parameters: [
          {
            type: 'document',
            document: {
              link: 'https://example.com/files/catalogue.pdf',
              filename: 'Auction Catalogue.pdf',
            },
          },
        ],
      },
    ]);
  });

  it('infers a document header filename from the URL when omitted', async () => {
    let components: unknown[] | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        components = body.template.components;
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.DOCUMENT' }] }),
          { status: 200 }
        );
      })
    );

    await sendTemplateMessage({
      ...TEMPLATE_BASE_ARGS,
      header: {
        type: 'document',
        media_url: 'https://example.com/files/auction%20catalogue.pdf',
      },
    });

    expect(components).toEqual([
      {
        type: 'header',
        parameters: [
          {
            type: 'document',
            document: {
              link: 'https://example.com/files/auction%20catalogue.pdf',
              filename: 'auction catalogue.pdf',
            },
          },
        ],
      },
    ]);
  });

  it('rejects a media header without a URL or media id before fetch', async () => {
    const fetch = vi.fn(neverFetch);
    vi.stubGlobal('fetch', fetch);

    await expect(
      sendTemplateMessage({
        ...TEMPLATE_BASE_ARGS,
        header: { type: 'image' },
      })
    ).rejects.toThrow(/requires media_url or media_id/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('sendInteractiveButtons — validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects an empty buttons array', async () => {
    await expect(
      sendInteractiveButtons({ ...BASE_ARGS, buttons: [] })
    ).rejects.toThrow(/1-3 buttons/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxButtons} buttons (Meta cap)`, async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      })
    ).rejects.toThrow(/1-3 buttons/);
  });

  it('rejects a button title longer than 20 chars (Meta cap)', async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          {
            id: 'a',
            title: 'x'.repeat(INTERACTIVE_LIMITS.buttonTitleMaxLength + 1),
          },
        ],
      })
    ).rejects.toThrow(/exceeds 20 chars/);
  });

  it('rejects a button missing its id', async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [{ id: '', title: 'Choose me' }],
      })
    ).rejects.toThrow(/missing id/);
  });

  it('rejects an empty body text', async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        bodyText: '',
        buttons: [{ id: 'a', title: 'A' }],
      })
    ).rejects.toThrow(/requires bodyText/);
  });

  it('rejects a header text over the limit', async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        headerText: 'x'.repeat(INTERACTIVE_LIMITS.headerTextMaxLength + 1),
        buttons: [{ id: 'a', title: 'A' }],
      })
    ).rejects.toThrow(/headerText exceeds/);
  });

  it('sends the right payload shape when all inputs are valid', async () => {
    let captured: { url: string; body: unknown; method: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url,
          method: init.method ?? 'GET',
          body: JSON.parse(String(init.body)),
        };
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.PASS' }] }),
          { status: 200 }
        );
      })
    );

    const result = await sendInteractiveButtons({
      ...BASE_ARGS,
      headerText: 'Hello',
      footerText: 'Tap one',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    });

    expect(result).toEqual({ messageId: 'wamid.PASS' });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe('POST');
    expect(captured!.url).toContain('test-phone/messages');
    expect(captured!.body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '1234567890',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Body text' },
        header: { type: 'text', text: 'Hello' },
        footer: { text: 'Tap one' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      },
    });
  });
});

describe('sendInteractiveList — validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ROW = { id: 'r1', title: 'Row 1' };

  it('rejects zero sections', async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: 'Open',
        sections: [],
      })
    ).rejects.toThrow(/1-10 sections/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across sections (Meta cap)`, async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i}`,
      title: `Row ${i}`,
    }));
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: 'Open',
        sections: [{ rows }],
      })
    ).rejects.toThrow(/1-10 rows total/);
  });

  it('rejects a row title longer than 24 chars (Meta cap)', async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: 'Open',
        sections: [
          {
            rows: [
              {
                id: 'r1',
                title: 'x'.repeat(INTERACTIVE_LIMITS.listRowTitleMaxLength + 1),
              },
            ],
          },
        ],
      })
    ).rejects.toThrow(/exceeds 24 chars/);
  });

  it('rejects duplicate row ids across sections', async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: 'Open',
        sections: [
          { rows: [{ id: 'dupe', title: 'First' }] },
          { rows: [{ id: 'dupe', title: 'Second' }] },
        ],
      })
    ).rejects.toThrow(/duplicate row id/);
  });

  it('rejects an empty buttonLabel', async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: '',
        sections: [{ rows: [ROW] }],
      })
    ).rejects.toThrow(/requires a buttonLabel/);
  });

  it('sends the right payload shape when valid', async () => {
    let captured: { body: unknown } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({ messages: [{ id: 'wamid.LIST' }] }),
          { status: 200 }
        );
      })
    );

    const result = await sendInteractiveList({
      ...BASE_ARGS,
      buttonLabel: 'Open menu',
      sections: [
        {
          title: 'Orders',
          rows: [
            { id: 'order_1', title: 'Order #1', description: '€12' },
            { id: 'order_2', title: 'Order #2' },
          ],
        },
      ],
    });

    expect(result).toEqual({ messageId: 'wamid.LIST' });
    expect(captured).not.toBeNull();
    expect(captured!.body).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: 'Body text' },
        action: {
          button: 'Open menu',
          sections: [
            {
              title: 'Orders',
              rows: [
                { id: 'order_1', title: 'Order #1', description: '€12' },
                { id: 'order_2', title: 'Order #2' },
              ],
            },
          ],
        },
      },
    });
  });
});
