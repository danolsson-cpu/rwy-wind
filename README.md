# RWY Wind

Runway headwind, tailwind and crosswind calculator for pilots. Works offline once installed on an iPhone (Safari → Share → Add to Home Screen).

Runway data: OurAirports (public domain). Magnetic variation: World Magnetic Model 2025.
For training and planning only. Always use official charts, ATIS and tower winds for flight.

# Weather (`weather/`)

iPhone weather app in the style of Apple's Liquid Glass design. Opens on your current position; the search bar at the bottom finds other cities (or U.S. ZIP codes), and you can save them to a list. Install from Safari → Share → Add to Home Screen.

Shows current conditions, hourly and 10-day forecast, wind (speed, gusts, direction compass), UV, feels like, humidity, visibility, pressure, sunrise/sunset and precipitation. For U.S. locations it also shows:

- **Severe weather alerts** — National Weather Service (api.weather.gov), tap for full text and instructions.
- **Air quality (AQI)** — EPA AirNow monitors when a free AirNow key is added in Settings, otherwise the Copernicus CAMS model (EU government) via Open-Meteo. Tap for pollutants.
- **Pollen** — tree, grass and weed levels plus the plant species in season. No U.S. government agency publishes pollen data, so U.S. pollen needs a free Google Pollen API key (Settings). In Europe, Copernicus CAMS pollen is used with no key.
- **Nearest wildfire** — miles and direction to the closest active wildfire from the National Interagency Fire Center (WFIGS current incidents), tap for the nearest fires with size and containment.

Forecast data comes from Open-Meteo, which serves national weather service models (NOAA HRRR/GFS in the U.S.). U.S. place names come from the NWS, others from OpenStreetMap. API keys are stored only on the device.
