@preconcurrency import CoreLocation
import Foundation

@MainActor
final class LocationProvider: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var latest: DetectionLocation?
    @Published private(set) var permission = "not requested"
    private let manager = CLLocationManager()
    private var active = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 2
    }

    func start() {
        active = true
        latest = nil
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            permission = "precise location active"
            manager.startUpdatingLocation()
        case .denied, .restricted: permission = "denied; detections continue without GPS"
        @unknown default: permission = "unknown"
        }
    }

    func stop() {
        active = false
        manager.stopUpdatingLocation()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard active else { return }
        start()
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, location.horizontalAccuracy >= 0 else { return }
        let result = DetectionLocation(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
            horizontalAccuracyM: location.horizontalAccuracy,
            altitudeM: location.verticalAccuracy >= 0 ? location.altitude : nil)
        Task { @MainActor in
            guard active else { return }
            latest = result
        }
    }
}
