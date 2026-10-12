# ECB Data Portal (SDMX): daily euro foreign exchange reference rates (units per EUR).
# Cross rates against CHF, USD etc. are derived in the browser from these.
# https://data.ecb.europa.eu/help/api/overview

fetch_ecb_fx <- function(countries, start = "2010-01-01") {
  ccys <- setdiff(unique(countries$currency), "EUR")
  url <- sprintf(
    "https://data-api.ecb.europa.eu/service/data/EXR/D.%s.EUR.SP00.A?startPeriod=%s&format=csvdata&detail=dataonly",
    paste(ccys, collapse = "+"), start
  )

  wide <- get_csv(url) |>
    transmute(currency = CURRENCY, date = TIME_PERIOD, value = as_num(OBS_VALUE)) |>
    filter(!is.na(value)) |>
    pivot_wider(names_from = currency, values_from = value) |>
    arrange(date)

  # Series that were discontinued (no rate in the last 30 days) are dropped rather than
  # shown as if current.
  recent <- wide |> filter(as.Date(date) >= max(as.Date(date)) - 30)
  live <- names(recent)[-1][colSums(!is.na(recent[-1])) > 0]

  list(
    freq = "D",
    unit = "units of currency per EUR",
    periods = wide$date,
    rates = map(wide[live], ~ signif(.x, 6))
  )
}
