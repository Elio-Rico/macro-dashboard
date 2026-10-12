# Shared helpers: HTTP requests, reshaping to the dashboard JSON format, writing files.

suppressPackageStartupMessages({
  library(httr2)
  library(jsonlite)
  library(readr)
  library(dplyr)
  library(tidyr)
  library(purrr)
})

# The IMF DataMapper blocks browser-like user agents, so keep this one plain.
USER_AGENT <- "macro-dashboard (+https://www.eliobolliger.com)"

http_get <- function(url) {
  request(url) |>
    req_user_agent(USER_AGENT) |>
    req_timeout(180) |>
    req_retry(
      max_tries = 4,
      is_transient = function(resp) resp_status(resp) %in% c(429, 500, 502, 503, 504),
      backoff = function(i) 10 * i
    ) |>
    req_perform()
}

get_json <- function(url) {
  resp_body_json(http_get(url), simplifyVector = FALSE)
}

# BIS, ECB and OECD all serve SDMX data as CSV; read everything as text first.
get_csv <- function(url) {
  txt <- resp_body_string(http_get(url))
  read_csv(I(txt), col_types = cols(.default = col_character()), progress = FALSE)
}

as_num <- function(x) {
  x <- suppressWarnings(as.numeric(x))
  x[is.nan(x)] <- NA_real_
  x
}

# Map a source-specific country code to the dashboard id (ISO3, "EMU" for the euro area).
recode_country <- function(code, countries, column) {
  lookup <- setNames(countries$id, countries[[column]])
  unname(lookup[code])
}

# Sequence of period labels between two periods, for A ("2024"), Q ("2024-Q1") and M ("2024-01").
period_seq <- function(from, to, freq) {
  to_index <- function(p) {
    switch(freq,
      A = as.integer(p),
      Q = as.integer(substr(p, 1, 4)) * 4 + as.integer(substr(p, 7, 7)) - 1,
      M = as.integer(substr(p, 1, 4)) * 12 + as.integer(substr(p, 6, 7)) - 1
    )
  }
  idx <- seq(to_index(from), to_index(to))
  switch(freq,
    A = as.character(idx),
    Q = sprintf("%d-Q%d", idx %/% 4, idx %% 4 + 1),
    M = sprintf("%d-%02d", idx %/% 12, idx %% 12 + 1)
  )
}

# Long data (indicator, country, period, value) -> list with a shared period axis and
# one value vector per indicator x country. Compact and easy to plot in the browser.
to_panel <- function(long, freq, digits = 3) {
  long <- long |> filter(!is.na(value), !is.na(country))
  periods <- period_seq(min(long$period), max(long$period), freq)
  series <- long |>
    split(long$indicator) |>
    map(function(d) {
      d |>
        split(d$country) |>
        map(function(x) {
          v <- rep(NA_real_, length(periods))
          v[match(x$period, periods)] <- round(x$value, digits)
          v
        })
    })
  list(freq = freq, periods = periods, series = series)
}

write_dashboard_json <- function(x, file) {
  write_json(x, file, auto_unbox = TRUE, na = "null", digits = NA, pretty = FALSE)
}
