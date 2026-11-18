import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** A tool call the fake model makes on its first turn. */
export interface ToolCase {
  label: string;
  tool: string;
  input: Record<string, unknown>;
}

/** What the runtime sent back for one tool call. */
export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface FakeMessagesApi {
  url: string;
  /** Every request body the runtime sent, in order. */
  bodies: string[];
  /** The result of each case, by label, once the runtime has sent it back. */
  results: Map<string, ToolResult>;
  close(): Promise<void>;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface MessagesRequest {
  model?: string;
  stream?: boolean;
  tools?: unknown[];
  messages?: { role?: string; content?: unknown }[];
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
  content?: string | { type: string; text?: string }[];
}

function isToolResult(block: unknown): block is ToolResultBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result'
  );
}

function textOf(result: ToolResultBlock): string {
  const { content } = result;
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => part.text ?? '').join('\n');
}

/** One assistant message as server-sent events, the way the API streams it. */
function stream(res: http.ServerResponse, model: string, content: Block[], stop: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type: string, data: Record<string, unknown>): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  const usage = {
    input_tokens: 10,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  send('message_start', {
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      const start = { type: 'tool_use', id: block.id, name: block.name, input: {} };
      const json = JSON.stringify(block.input);
      send('content_block_start', { index, content_block: start });
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: json },
      });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send('message_stop', {});
  res.end();
}

/**
 * A stand-in for the Messages API on 127.0.0.1, so the real runtime can run with no tokens
 * and no network. The first turn that offers tools is answered with one tool_use block per
 * case; the tool_result blocks the runtime sends back are recorded, and the session ends
 * with "done". Every request body is kept, to be searched for anything that leaked.
 */
export async function startFakeMessagesApi(cases: readonly ToolCase[]): Promise<FakeMessagesApi> {
  const bodies: string[] = [];
  const results = new Map<string, ToolResult>();
  let toolsSent = false;

  const answer = (req: http.IncomingMessage, res: http.ServerResponse, body: string): void => {
    bodies.push(body);
    const url = req.url ?? '';
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST' || !url.startsWith('/v1/messages')) return json(404, {});
    if (url.startsWith('/v1/messages/count_tokens')) return json(200, { input_tokens: 100 });
    const request = JSON.parse(body) as MessagesRequest;
    // Tool results follow the last assistant turn, though not always last: for some models
    // the runtime adds a system message after them.
    const messages = request.messages ?? [];
    const sinceAssistant = messages.slice(messages.map((m) => m.role).lastIndexOf('assistant') + 1);
    const returned = sinceAssistant.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter(isToolResult) : [],
    );
    let content: Block[];
    let stop: string;
    if (returned.length > 0) {
      for (const result of returned) {
        const label = cases[Number(result.tool_use_id.replace('toolu_case_', ''))]?.label;
        if (label !== undefined) {
          results.set(label, { isError: result.is_error === true, text: textOf(result) });
        }
      }
      content = [{ type: 'text', text: 'done' }];
      stop = 'end_turn';
    } else if (!toolsSent && (request.tools?.length ?? 0) > 0) {
      toolsSent = true;
      content = cases.map((c, i) => ({
        type: 'tool_use',
        id: `toolu_case_${i}`,
        name: c.tool,
        input: c.input,
      }));
      stop = 'tool_use';
    } else {
      content = [{ type: 'text', text: 'ok' }];
      stop = 'end_turn';
    }
    const model = request.model ?? 'fake';
    if (request.stream === true) return stream(res, model, content, stop);
    json(200, {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => answer(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    results,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
