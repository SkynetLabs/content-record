import ContentRecordDAC from './dac'

const skylink = "_AJuK4l9MD8EL0axpf76cucfPC9CIgYfoxDO4vCAFKs_MA"
describe('DAC', () => {
  it('should validate skylinks when adding interactions entries', async () => { 
    const dac = new ContentRecordDAC()

    let invalidEntry = { skylink: "", metadata: { foo: "bar" } }
    let response = await dac.recordInteraction(invalidEntry)
    expect(response.submitted).toBe(false)

    invalidEntry = { skylink: skylink+"abc", metadata: { foo: "bar" } }
    response = await dac.recordInteraction(invalidEntry)
    expect(response.submitted).toBe(false)

    let validEntry = { skylink, metadata: { foo: "bar" } }
    response = await dac.recordInteraction(validEntry)
    expect(response.submitted).toBe(true)

    validEntry = { skylink: "sia://"+skylink, metadata: { foo: "bar" } }
    response = await dac.recordInteraction(validEntry)
    expect(response.submitted).toBe(true)

    validEntry = { skylink: "sia://"+skylink+"/path", metadata: { foo: "bar" } }
    response = await dac.recordInteraction(validEntry)
    expect(response.submitted).toBe(true)
  })

  it('should validate skylinks when adding newcontent entries', async () => { 
    const dac = new ContentRecordDAC()

    let invalidEntry = { skylink: "", metadata: { foo: "bar" } }
    let response = await dac.recordNewContent(invalidEntry)
    expect(response.submitted).toBe(false)

    invalidEntry = { skylink: skylink+"abc", metadata: { foo: "bar" } }
    response = await dac.recordNewContent(invalidEntry)
    expect(response.submitted).toBe(false)

    let validEntry = { skylink, metadata: { foo: "bar" } }
    response = await dac.recordNewContent(validEntry)
    expect(response.submitted).toBe(true)

    validEntry = { skylink: "sia://"+skylink, metadata: { foo: "bar" } }
    response = await dac.recordNewContent(validEntry)
    expect(response.submitted).toBe(true)

    validEntry = { skylink: "sia://"+skylink+"/path", metadata: { foo: "bar" } }
    response = await dac.recordNewContent(validEntry)
    expect(response.submitted).toBe(true)
  })
})