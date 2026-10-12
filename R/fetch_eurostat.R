# Eurostat dissemination API (JSON-stat 2.0): quarterly government finance statistics.
# https://wikis.ec.europa.eu/display/EUROSTATHELP/API+Statistics+-+data+query

# Flatten a JSON-stat response into one row per observation. Values are stored in a
# single row-major array, with the last dimension varying fastest.
jsonstat_to_tibble <- function(js) {
  dims <- unlist(js$id)
  sizes <- unlist(js$size)
  labels <- map(dims, function(d) {
    idx <- unlist(js$dimension[[d]]$category$index)
    names(sort(idx))
  })
  names(labels) <- dims
  grid <- expand.grid(rev(labels), stringsAsFactors = FALSE)[, rev(dims), drop = FALSE]
  values <- rep(NA_real_, prod(sizes))
  pos <- as.integer(names(js$value)) + 1
  values[pos] <- as.numeric(unlist(js$value))
  as_tibble(grid) |> mutate(value = values)
}

eurostat_get <- function(dataset, filters, geos, since) {
  query <- c(
    paste0(names(filters), "=", filters),
    paste0("geo=", geos),
    paste0("sinceTimePeriod=", since)
  )
  url <- paste0(
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/", dataset,
    "?", paste(query, collapse = "&")
  )
  jsonstat_to_tibble(get_json(url))
}

fetch_eurostat_gov <- function(countries, since = "2000-Q1") {
  geos <- countries$eurostat[!is.na(countries$eurostat) & countries$eurostat != ""]

  debt <- eurostat_get(
    "gov_10q_ggdebt",
    c(unit = "PC_GDP", sector = "S13", na_item = "GD"),
    geos, since
  ) |>
    mutate(indicator = "gov_debt_q")

  balance <- eurostat_get(
    "gov_10q_ggnfa",
    c(unit = "PC_GDP", sector = "S13", na_item = "B9", s_adj = "SCA"),
    geos, since
  ) |>
    mutate(indicator = "gov_balance_q")

  long <- bind_rows(debt, balance) |>
    transmute(
      indicator,
      country = recode_country(geo, countries, "eurostat"),
      period = time,
      value
    )

  to_panel(long, "Q", digits = 1)
}
