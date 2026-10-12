# OECD Data Explorer (SDMX): quarterly national accounts, real GDP (chain-linked volumes,
# seasonally and calendar adjusted). Growth rates are computed here from the levels.
# https://data-explorer.oecd.org

fetch_oecd_gdp <- function(countries, start = "1999-Q1") {
  areas <- paste(na.omit(countries$oecd[countries$oecd != ""]), collapse = "+")
  url <- paste0(
    "https://sdmx.oecd.org/public/rest/data/OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA,1.1/",
    "Q.Y.", areas, ".S1.S1.B1GQ._Z._Z._Z.XDC.LR.LA.T0102",
    "?startPeriod=", start, "&format=csvfile"
  )

  levels <- get_csv(url) |>
    transmute(
      country = recode_country(REF_AREA, countries, "oecd"),
      period = TIME_PERIOD,
      level = as_num(OBS_VALUE)
    ) |>
    filter(!is.na(country), !is.na(level)) |>
    distinct(country, period, .keep_all = TRUE) |>
    arrange(country, period)

  growth <- levels |>
    group_by(country) |>
    complete(period = period_seq(min(period), max(period), "Q")) |>
    mutate(
      gdp_qoq = 100 * (level / lag(level, 1) - 1),
      gdp_yoy = 100 * (level / lag(level, 4) - 1)
    ) |>
    ungroup() |>
    select(-level) |>
    pivot_longer(c(gdp_qoq, gdp_yoy), names_to = "indicator") |>
    filter(period >= "2000-Q1")

  to_panel(growth, "Q", digits = 2)
}
