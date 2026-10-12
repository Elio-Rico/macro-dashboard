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

# EU-SILC: share of the population by housing tenure (owner with/without mortgage, tenant).
# Covers EU and EFTA countries (incl. Switzerland) and some candidate countries.
fetch_eurostat_housing <- function(countries, since = "2005") {
  tenure_ids <- c(OWN = "home_own", OWN_L = "home_own_mortgage", OWN_NL = "home_own_outright", RENT = "home_rent")
  url <- paste0(
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/ilc_lvho02?",
    paste0("tenure=", names(tenure_ids), collapse = "&"),
    "&hhcomp=TOTAL&rskpovth=TOTAL&unit=PC&sinceTimePeriod=", since
  )
  js <- get_json(url)
  geo_labels <- unlist(js$dimension$geo$category$label)
  all <- jsonstat_to_tibble(js) |>
    filter(!is.na(value)) |>
    transmute(geo, tenure, year = time, value)

  # Dashboard countries: Eurostat code where set, otherwise the ISO2 code (e.g. CH).
  geo_of <- coalesce(na_if(countries$eurostat, ""), countries$bis)
  geo_of[countries$id == "EMU"] <- NA
  geo_of[geo_of == "GB"] <- "UK"
  long <- all |>
    transmute(
      indicator = unname(tenure_ids[tenure]),
      country = unname(setNames(countries$id, geo_of)[geo]),
      period = year,
      value
    )
  panel <- to_panel(long, "A", digits = 1)

  # Latest year per country for the cross-country comparison (all reporting countries,
  # plus the EU-27 aggregate; other aggregates are dropped).
  latest <- all |>
    filter(!grepl("^EA|^EU", geo) | geo == "EU27_2020") |>
    pivot_wider(names_from = tenure, values_from = value) |>
    filter(!is.na(OWN), !is.na(OWN_L), !is.na(OWN_NL)) |>
    group_by(geo) |>
    slice_max(year, n = 1) |>
    ungroup()
  # Drop countries that stopped reporting (e.g. the UK after 2018).
  latest <- latest |> filter(as.integer(year) >= max(as.integer(year)) - 2)
  panel$latest <- latest |>
    transmute(
      geo,
      id = unname(setNames(countries$id, geo_of)[geo]),
      name = if_else(geo == "EU27_2020", "EU-27", unname(geo_labels[geo])),
      year,
      own = OWN, own_mortgage = OWN_L, own_outright = OWN_NL, rent = RENT
    ) |>
    arrange(desc(own)) |>
    pmap(list)

  panel
}
