# Audio fixtures

These files are local test fixtures sourced from
[`batear-io/batear-datasets`](https://github.com/batear-io/batear-datasets),
which is published under the MIT license.

| Local file | Upstream file | Local processing |
| --- | --- | --- |
| `batear-fpv-5inch.wav` | `field-tests/FPV/5inch_resampled/20260415_192504.wav` | Unchanged |
| `batear-mavic-pro.wav` | `field-tests/DJI/mavic-pro/20260428/2474750763FAA288_20260428_072210.WAV` | Converted to mono PCM at 16 kHz |
| `batear-mini-4-pro.wav` | `field-tests/DJI/mini-4-pro/20260428/2474750763FAA288_20260428_080410.WAV` | Converted to mono PCM at 16 kHz |
| `batear-rural-8s.wav` | `field-tests/ambient/rural/20230701_054200.WAV` | First 8 seconds, converted to mono PCM at 16 kHz |

The model labels are used only as evaluation truth in the UI and tests. The
detector receives decoded PCM samples without the file name or expected label.
