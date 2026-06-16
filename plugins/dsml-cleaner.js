/**
 * DSML Cleaner Transformer for claude-code-router
 *
 * Strips DeepSeek V4 DSML token fragments that leak into content
 * during streaming mode (vLLM bug: github.com/vllm-project/vllm/issues/40801)
 *
 * DSML tokens use fullwidth pipe (U+FF5C): ｜DSML｜invoke, ｜DSML｜parameter, etc.
 *
 * IMPORTANT: This plugin only does raw-text regex replacement on SSE lines.
 * It does NOT parse/re-serialize JSON, to avoid changing key order,
 * dropping fields, or altering the stream structure that downstream
 * transformers (built-in deepseek) rely on.
 */

class DSMLCleanerTransformer {
  constructor(options = {}) {
    this.name = 'dsml-cleaner';
    this.logger = options.logger || console;
    // Match complete DSML fragments in raw SSE line
    this.dsmlPattern = /[｜|]\s*DSML\s*[｜|][^\n]*/g;
    // Match partial DSML at end of line (chunk boundary)
    this.partialPattern = /[｜|]\s*DSML\s*$/;
  }

  async transformRequestIn(request) {
    return request;
  }

  async transformResponseOut(response) {
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      return this._cleanJSON(response);
    } else if (contentType.includes('stream')) {
      return this._cleanStream(response);
    }

    return response;
  }

  async _cleanJSON(response) {
    const data = await response.json();

    if (data?.choices) {
      for (const choice of data.choices) {
        if (choice.message?.content) {
          choice.message.content = this._stripDSML(choice.message.content);
        }
        if (choice.delta?.content) {
          choice.delta.content = this._stripDSML(choice.delta.content);
        }
      }
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  _cleanStream(response) {
    if (!response.body) return response;

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const self = this;

    const readable = new ReadableStream({
      async start(controller) {
        const reader = response.body.getReader();

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            // Pass through raw bytes, replacing DSML in-place
            const chunk = decoder.decode(value, { stream: true });
            const cleaned = self._stripDSML(chunk);
            controller.enqueue(encoder.encode(cleaned));
          }
        } catch (err) {
          self.logger.error?.('DSML cleaner stream error:', err.message);
        } finally {
          controller.close();
        }
      }
    });

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  /**
   * Strip DSML tokens from text.
   * Does NOT compress whitespace or trim — only removes DSML markers.
   */
  _stripDSML(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(this.dsmlPattern, '').replace(this.partialPattern, '');
  }
}

module.exports = DSMLCleanerTransformer;
