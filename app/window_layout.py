"""Initial window geometry in the monitor's native coordinate space."""


def fitted_bounds(area, scale=1.0):
    left, top, width, height = area
    margin = max(12, round(24 * scale))
    available_w, available_h = max(1, width - margin * 2), max(1, height - margin * 2)
    window_w = min(round(1440 * scale), available_w, round(width * .92))
    window_h = min(round(960 * scale), available_h, round(height * .92))
    return (left + (width - window_w) // 2, top + (height - window_h) // 2,
            window_w, window_h, min(round(860 * scale), window_w),
            min(round(600 * scale), window_h))
