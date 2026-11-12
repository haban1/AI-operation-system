import Foundation
import Vision

struct FrameDescription: Codable {
    let labels: [String]
    let detectedPeople: Int
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let classification = VNClassifyImageRequest()
let people = VNDetectHumanRectanglesRequest()
people.upperBodyOnly = true
let handler = VNImageRequestHandler(url: url, options: [:])
do {
    try handler.perform([classification, people])
    let labels = (classification.results ?? [])
        .filter { $0.confidence >= 0.08 }
        .prefix(10)
        .map { $0.identifier }
    let description = FrameDescription(labels: labels, detectedPeople: people.results?.count ?? 0)
    FileHandle.standardOutput.write(try JSONEncoder().encode(description))
} catch {
    FileHandle.standardError.write(Data("Local image classification failed".utf8))
    exit(1)
}
