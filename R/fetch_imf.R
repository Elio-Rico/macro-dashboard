# IMF DataMapper API: World Economic Outlook and Fiscal Monitor, annual, incl. projections.
# https://www.imf.org/external/datamapper/api/help

fetch_imf <- function(indicators, countries, start_year = 2000) {
  ind <- indicators |> filter(source == "imf")

  long <- map2_dfr(ind$id, ind$code, function(id, code) {
    js <- get_json(paste0("https://www.imf.org/external/datamapper/api/v1/", code))
    vals <- js$values[[code]][intersect(countries$imf, names(js$values[[code]]))]
    map2_dfr(vals, names(vals), function(obs, imf_code) {
      tibble(
        indicator = id,
        country = recode_country(imf_code, countries, "imf"),
        period = names(obs),
        value = map_dbl(obs, ~ if (is.null(.x)) NA_real_ else as.numeric(.x))
      )
    })
  }) |>
    filter(as.integer(period) >= start_year)

  stopifnot(nrow(long) > 0)
  panel <- to_panel(long, "A")
  # The WEO projection horizon is always five years beyond the vintage year, so the
  # first projection year is the last year minus five (e.g. 2026 for data up to 2031).
  panel$projection_start <- as.character(as.integer(max(panel$periods)) - 5)
  panel
}
