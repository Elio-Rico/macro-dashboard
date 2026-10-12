# BIS Data Portal (SDMX): consumer prices, policy rates, effective exchange rates, total credit.
# https://data.bis.org  -  API docs: https://stats.bis.org/api-doc/v1/

bis_url <- function(flow, key, start) {
  sprintf("https://stats.bis.org/api/v1/data/%s/%s/all?format=csv&startPeriod=%s", flow, key, start)
}

bis_tidy <- function(df, indicator, countries, country_col = "REF_AREA") {
  df |>
    transmute(
      indicator = indicator,
      country = recode_country(.data[[country_col]], countries, "bis"),
      period = TIME_PERIOD,
      value = as_num(OBS_VALUE)
    ) |>
    filter(!is.na(country))
}

# Monthly: CPI inflation (y/y), policy rates, nominal and real effective exchange rates.
fetch_bis_monthly <- function(countries, start = "2000-01") {
  areas <- paste(countries$bis, collapse = "+")

  cpi <- get_csv(bis_url("WS_LONG_CPI", paste0("M.", areas, ".771"), start)) |>
    bis_tidy("cpi_yoy", countries)

  policy <- get_csv(bis_url("WS_CBPOL", paste0("M.", areas), start)) |>
    bis_tidy("policy_rate", countries)

  eer <- get_csv(bis_url("WS_EER", paste0("M.N+R.B.", areas), start)) |>
    mutate(ind = if_else(EER_TYPE == "N", "neer", "reer")) |>
    split(~ind) |>
    imap_dfr(~ bis_tidy(.x, .y, countries))

  panel <- to_panel(bind_rows(cpi, policy, eer), "M")

  # Latest daily policy rate, so the overview shows the rate in force today rather
  # than at the last month end.
  latest <- get_csv(sprintf(
    "https://stats.bis.org/api/v1/data/WS_CBPOL/D.%s/all?format=csv&lastNObservations=1", areas
  )) |>
    bis_tidy("policy_rate", countries)
  panel$policy_rate_latest <- latest |>
    filter(!is.na(value)) |>
    split(~country) |>
    map(~ list(date = .x$period[1], value = .x$value[1]))

  panel
}

# Quarterly: total credit to the non-financial sectors, % of GDP. Private sectors at market
# value; government at nominal value (wider coverage, closer to the Maastricht definition).
fetch_bis_credit <- function(countries, start = "2000-Q1") {
  areas <- paste(countries$bis, collapse = "+")
  sector_ids <- c(H = "credit_hh", N = "credit_nfc", P = "credit_pnfs", G = "credit_gov")

  private <- get_csv(bis_url("WS_TC", paste0("Q.", areas, ".H+N+P.A.M.770.A"), start))
  government <- get_csv(bis_url("WS_TC", paste0("Q.", areas, ".G.A.N.770.A"), start))

  long <- bind_rows(private, government) |>
    transmute(
      indicator = unname(sector_ids[TC_BORROWERS]),
      country = recode_country(BORROWERS_CTY, countries, "bis"),
      period = TIME_PERIOD,
      value = as_num(OBS_VALUE)
    )

  to_panel(long, "Q", digits = 1)
}
