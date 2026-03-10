FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y unzip curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

COPY . .

RUN deno cache --reload --node-modules-dir=auto npm:playwright

CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "--allow-write", "--allow-run", "--allow-sys", "scraper.ts"]
