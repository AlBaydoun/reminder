import Foundation
import Capacitor
import UIKit
import UniformTypeIdentifiers
import AVFoundation

/**
 * Alarm sounds from the user's own phone, on iOS.
 *
 * iOS has no ringtone picker to hand over to — the system ringtones are not
 * readable by apps at all, and a notification sound must be a file inside the
 * app's own container. So the equivalent gesture here is "pick an audio file",
 * and the file is copied into Library/Sounds, which is the one directory
 * UNNotificationSound will look in besides the bundle.
 *
 * The copy is the important part. Referencing the file where the user keeps it
 * would give an alarm that stops working the moment they move it, and the
 * failure would only show up at the moment the alarm was supposed to ring.
 */
@objc(DeviceSoundsPlugin)
public class DeviceSoundsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceSoundsPlugin"
    public let jsName = "DeviceSounds"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickRingtone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickAudioFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "check", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var player: AVAudioPlayer?

    /// iOS cannot offer the system ringtones, so this is the file picker.
    @objc func pickRingtone(_ call: CAPPluginCall) {
        pickAudioFile(call)
    }

    @objc func pickAudioFile(_ call: CAPPluginCall) {
        call.keepAlive = true
        pendingCall = call

        DispatchQueue.main.async {
            let types: [UTType] = [.audio, .mp3, .wav, .aiff, .mpeg4Audio]
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    @objc func preview(_ call: CAPPluginCall) {
        guard let name = call.getString("uri"), !name.isEmpty else {
            call.reject("No sound to play")
            return
        }
        guard let url = soundURL(for: name) else {
            call.reject("That sound is no longer on this phone")
            return
        }
        do {
            // Alarms should be audible with the ring switch on silent, and the
            // preview should behave the way the alarm will.
            try AVAudioSession.sharedInstance().setCategory(.playback, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            player?.stop()
            player = try AVAudioPlayer(contentsOf: url)
            player?.play()
            call.resolve()
        } catch {
            call.reject("That sound could not be played: \(error.localizedDescription)")
        }
    }

    @objc func stopPreview(_ call: CAPPluginCall) {
        player?.stop()
        player = nil
        call.resolve()
    }

    @objc func check(_ call: CAPPluginCall) {
        let name = call.getString("uri") ?? ""
        call.resolve(["ok": !name.isEmpty && soundURL(for: name) != nil])
    }

    /// Where a notification sound has to live for iOS to find it by name.
    private func soundsDirectory() throws -> URL {
        let library = try FileManager.default.url(
            for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let sounds = library.appendingPathComponent("Sounds", isDirectory: true)
        if !FileManager.default.fileExists(atPath: sounds.path) {
            try FileManager.default.createDirectory(at: sounds, withIntermediateDirectories: true)
        }
        return sounds
    }

    private func soundURL(for name: String) -> URL? {
        if let sounds = try? soundsDirectory() {
            let candidate = sounds.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        }
        // The tones that ship with the app live in the bundle instead.
        if let bundled = Bundle.main.url(forResource: name, withExtension: nil) { return bundled }
        return nil
    }
}

extension DeviceSoundsPlugin: UIDocumentPickerDelegate {
    public func documentPicker(
        _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        defer { call.keepAlive = false }

        guard let source = urls.first else {
            call.resolve(["cancelled": true])
            return
        }

        do {
            let sounds = try soundsDirectory()
            // A name iOS will accept and that cannot collide with an existing
            // one, while still being recognisable in the sound list.
            let safe = source.deletingPathExtension().lastPathComponent
                .replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
            let ext = source.pathExtension.isEmpty ? "caf" : source.pathExtension
            let filename = "nexus_user_\(safe)_\(Int(Date().timeIntervalSince1970)).\(ext)"
            let destination = sounds.appendingPathComponent(filename)

            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.copyItem(at: source, to: destination)

            call.resolve([
                "cancelled": false,
                "uri": filename,
                "name": source.deletingPathExtension().lastPathComponent
            ])
        } catch {
            call.reject("That sound could not be saved: \(error.localizedDescription)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        call.keepAlive = false
        call.resolve(["cancelled": true])
    }
}
