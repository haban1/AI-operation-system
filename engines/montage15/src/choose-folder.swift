import AppKit
import Foundation

final class FolderPickerDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.title = "选择智能混剪的素材来源文件夹"
            panel.message = "文件夹内的照片与视频会在本机建立索引"
            panel.prompt = "使用此文件夹"
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = false
            NSApplication.shared.activate(ignoringOtherApps: true)
            if panel.runModal() == .OK, let url = panel.url {
                FileHandle.standardOutput.write(Data(url.path.utf8))
            }
            NSApplication.shared.terminate(nil)
        }
    }
}

let application = NSApplication.shared
let delegate = FolderPickerDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
