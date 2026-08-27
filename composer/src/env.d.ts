declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    BROWSER: BrowserRun;
    COMPOSER_RATE_LIMITER: RateLimit;
    COMPOSER_INSPECTION_MODEL: string;
    COMPOSER_MODEL: string;
    INSPECTION_ORIGIN: string;
    LOADER: WorkerLoader;
    OPENAI_API_KEY: string;
  }
}
