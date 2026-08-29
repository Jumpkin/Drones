import Foundation
import onnxruntime_objc

final class ONNXModelRunner {
    private let session: ORTSession
    private let inputName: String
    private let outputName: String
    private let shape: [NSNumber]

    init(resource: String, inputName: String, outputName: String, shape: [NSNumber]) throws {
        guard let path = Bundle.main.path(forResource: resource, ofType: "onnx") ??
                Bundle.main.path(forResource: resource, ofType: "onnx", inDirectory: "Models") else {
            throw CocoaError(.fileNoSuchFile)
        }
        let environment = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(1)
        try options.setGraphOptimizationLevel(ORTGraphOptimizationLevel.all)
        session = try ORTSession(env: environment, modelPath: path, sessionOptions: options)
        self.inputName = inputName
        self.outputName = outputName
        self.shape = shape
    }

    func probability(_ values: [Float]) throws -> Double {
        let data = values.withUnsafeBytes { bytes in
            NSMutableData(bytes: bytes.baseAddress!, length: bytes.count)
        }
        let tensor = try ORTValue(tensorData: data, elementType: ORTTensorElementDataType.float, shape: shape)
        let outputs = try session.run(withInputs: [inputName: tensor], outputNames: [outputName], runOptions: nil)
        guard let output = outputs[outputName] else { throw CocoaError(.coderInvalidValue) }
        let outputData = try output.tensorData()
        guard outputData.length >= MemoryLayout<Float>.size else { throw CocoaError(.coderReadCorrupt) }
        return Double(outputData.bytes.assumingMemoryBound(to: Float.self).pointee)
    }
}
