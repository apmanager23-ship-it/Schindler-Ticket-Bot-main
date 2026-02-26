# Schindler Exhibition Ticket Scraper

Bot sprawdzający dostępność biletów na wystawę Fabryki Schindlera i wysyłający powiadomienia do Discord.

## Uruchomienie lokalnie

```bash
deno run --allow-net --allow-read --allow-env --allow-write --allow-run --allow-sys scraper.ts
```

## Deployment na Railway

Bot automatycznie uruchamia się co godzinę sprawdzając dostępność biletów.
